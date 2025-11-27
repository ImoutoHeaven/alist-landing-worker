package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	errors "git.sequentialread.com/forest/pkg-errors"
	"golang.org/x/crypto/argon2"
)

const (
	defaultListenPort            = 2370
	defaultBatchSize             = 1000
	defaultDeprecateAfterBatches = 10
	defaultArgonMemoryKiB        = 16384
	defaultArgonIterations       = 2
	defaultArgonParallelism      = 1
	defaultArgonKeyLength        = 16
)

type Config struct {
	ListenPort            int `json:"listen_port"`
	BatchSize             int `json:"batch_size"`
	DeprecateAfterBatches int `json:"deprecate_after_batches"`

	Argon2MemoryKiB   int `json:"argon2_memory_kib"`
	Argon2Iterations  int `json:"argon2_iterations"`
	Argon2Parallelism int `json:"argon2_parallelism"`
	Argon2KeyLength   int `json:"argon2_key_length"`

	AdminAPIToken string `json:"admin_api_token"`
}

// Argon2id parameters embedded in the challenge JSON
type Argon2Parameters struct {
	MemoryKiB   int `json:"m"`    // Argon2 memory, KiB
	Iterations  int `json:"t"`    // Argon2 time cost (iterations)
	Parallelism int `json:"p"`    // Argon2 lanes
	KeyLength   int `json:"klen"` // Output length (bytes)
}

type Challenge struct {
	Argon2Parameters
	Preimage        string `json:"i"`
	Difficulty      string `json:"d"`
	DifficultyLevel int    `json:"dl"`
}

type controllerEnv struct {
	URL        string `json:"url"`
	APIPrefix  string `json:"api_prefix"`
	APIToken   string `json:"api_token"`
	Env        string `json:"env"`
	Role       string `json:"role"`
	InstanceID string `json:"instance_id"`
	AppName    string `json:"app_name"`
	AppVersion string `json:"app_version"`
}

type runtimeMeta struct {
	appName    string
	appVersion string
	env        string
	role       string
	instanceID string
}

type metricsSnapshot struct {
	Timestamp      int64
	ConfigVersion  string
	Counts         map[string]int64
	ChallengeCache int
	TokenCount     int
}

type fileConfigMeta struct {
	Controller       controllerEnv `json:"controller"`
	InternalAPIToken string        `json:"internal_api_token"`
}

func (m metricsSnapshot) empty() bool {
	return len(m.Counts) == 0 && m.ChallengeCache == 0 && m.TokenCount == 0
}

type metricsReporter struct {
	env      controllerEnv
	meta     runtimeMeta
	client   *http.Client
	interval time.Duration
}

type metricsCounters struct {
	mu     sync.Mutex
	counts map[string]int64
}

var config Config
var configMu sync.RWMutex
var argon2Parameters Argon2Parameters
var configVersion string
var appDirectory string
var apiTokensFolder string
var controllerSettings controllerEnv
var internalAPIToken string
var runtimeInfo runtimeMeta
var metricsCollector *metricsCounters
var metricsReporterInstance *metricsReporter
var metricsLoopOnce sync.Once

var currentChallengesGeneration = map[string]int{}
var challenges = map[string]map[string]int{}
var challengesMu sync.RWMutex

type tokenCache struct {
	tokens map[string]struct{}
	mu     sync.RWMutex
}

var apiTokensCache = tokenCache{tokens: map[string]struct{}{}}

func main() {
	metricsCollector = newMetricsCounters()

	if err := readConfiguration(); err != nil {
		log.Fatalf("failed to load configuration: %v", err)
	}

	startMetricsReporter()
	registerInternalAPI()

	requireMethod := func(method string) func(http.ResponseWriter, *http.Request) bool {
		return func(responseWriter http.ResponseWriter, request *http.Request) bool {
			if request.Method != method {
				responseWriter.Header().Set("Allow", method)
				http.Error(responseWriter, fmt.Sprintf("405 Method Not Allowed, try %s", method), http.StatusMethodNotAllowed)
				return true
			}
			return false
		}
	}

	requireAdmin := func(responseWriter http.ResponseWriter, request *http.Request) bool {
		adminToken := strings.TrimSpace(currentConfig().AdminAPIToken)
		if request.Header.Get("Authorization") != fmt.Sprintf("Bearer %s", adminToken) {
			http.Error(responseWriter, "401 Unauthorized", http.StatusUnauthorized)
			return true
		}
		return false
	}

	requireToken := func(responseWriter http.ResponseWriter, request *http.Request) bool {
		authorizationHeader := request.Header.Get("Authorization")
		if !strings.HasPrefix(authorizationHeader, "Bearer ") {
			metricsAdd("auth_missing_header")
			http.Error(responseWriter, "401 Unauthorized: Authorization header is required and must start with 'Bearer '", http.StatusUnauthorized)
			return true
		}
		token := strings.TrimPrefix(authorizationHeader, "Bearer ")
		if token == "" {
			metricsAdd("auth_missing_token")
			http.Error(responseWriter, "401 Unauthorized: Authorization Bearer token is required", http.StatusUnauthorized)
			return true
		}
		if !regexp.MustCompile("^[0-9a-f]{32}$").MatchString(token) {
			metricsAdd("auth_invalid_format")
			errorMsg := fmt.Sprintf("401 Unauthorized: Authorization Bearer token '%s' must be a 32 character hex string", token)
			http.Error(responseWriter, errorMsg, http.StatusUnauthorized)
			return true
		}
		if !tokenExists(token) {
			metricsAdd("auth_unrecognized_token")
			errorMsg := fmt.Sprintf("401 Unauthorized: Authorization Bearer token '%s' was in the right format, but it was unrecognized", token)
			http.Error(responseWriter, errorMsg, http.StatusUnauthorized)
			return true
		}
		return false
	}

	myHTTPHandleFunc("/Tokens", requireMethod("GET"), requireAdmin, func(responseWriter http.ResponseWriter, request *http.Request) bool {
		fileInfos, err := ioutil.ReadDir(apiTokensFolder)
		if err != nil {
			log.Printf("failed to list the apiTokensFolder (%s): %v", apiTokensFolder, err)
			http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
			return true
		}

		output := []string{}

		for _, fileInfo := range fileInfos {
			filenameSplit := strings.Split(fileInfo.Name(), "_")
			if len(filenameSplit) == 2 {
				filepath := path.Join(apiTokensFolder, fileInfo.Name())
				content, err := ioutil.ReadFile(filepath)
				if err != nil {
					log.Printf("failed to read the token file (%s): %v", filepath, err)
					http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
					return true
				}
				contentInt64, err := strconv.ParseInt(string(content), 10, 64)
				timestampString := time.Unix(contentInt64, 0).UTC().Format(time.RFC3339)
				output = append(output, fmt.Sprintf("%s,%s,%d,%s", filenameSplit[0], filenameSplit[1], contentInt64, timestampString))
			}

		}

		responseWriter.Header().Set("Content-Type", "text/plain")
		responseWriter.Write([]byte(strings.Join(output, "\n")))

		return true
	})

	myHTTPHandleFunc("/Tokens/Create", requireMethod("POST"), requireAdmin, func(responseWriter http.ResponseWriter, request *http.Request) bool {
		name := request.URL.Query().Get("name")
		if name == "" {
			http.Error(responseWriter, "400 Bad Request: url param ?name=<string> is required", http.StatusBadRequest)
			return true
		}
		// we use underscore as a syntax character in the filename, so we have to remove it from the user-inputted name
		name = strings.ReplaceAll(name, "_", "-")
		// let's also remove any sort of funky or path-related characters
		name = strings.ReplaceAll(name, "*", "")
		name = strings.ReplaceAll(name, "?", "")
		name = strings.ReplaceAll(name, "/", "-")
		name = strings.ReplaceAll(name, "\\", "-")
		name = strings.ReplaceAll(name, ".", "-")

		tokenBytes := make([]byte, 16)
		rand.Read(tokenBytes)

		tokenHex := fmt.Sprintf("%x", tokenBytes)
		ioutil.WriteFile(
			path.Join(apiTokensFolder, fmt.Sprintf("%s_%s", tokenHex, name)),
			[]byte(fmt.Sprintf("%d", time.Now().Unix())),
			0644,
		)

		apiTokensCache.mu.Lock()
		apiTokensCache.tokens[tokenHex] = struct{}{}
		apiTokensCache.mu.Unlock()

		metricsAdd("token_created")
		fmt.Fprintf(responseWriter, "%s", tokenHex)

		return true
	})

	myHTTPHandleFunc("/Tokens/Revoke", requireMethod("POST"), requireAdmin, func(responseWriter http.ResponseWriter, request *http.Request) bool {
		token := request.URL.Query().Get("token")
		if token == "" {
			http.Error(responseWriter, "400 Bad Request: url param ?token=<string> is required", http.StatusBadRequest)
			return true
		}
		if !regexp.MustCompile("^[0-9a-f]{32}$").MatchString(token) {
			errorMsg := fmt.Sprintf("400 Bad Request: url param ?token=%s must be a 32 character hex string", token)
			http.Error(responseWriter, errorMsg, http.StatusBadRequest)
			return true
		}

		fileInfos, err := ioutil.ReadDir(apiTokensFolder)
		if err != nil {
			log.Printf("failed to list the apiTokensFolder (%s): %v", apiTokensFolder, err)
			http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
			return true
		}
		removed := false
		for _, fileInfo := range fileInfos {
			if strings.HasPrefix(fileInfo.Name(), token) {
				os.Remove(path.Join(apiTokensFolder, fileInfo.Name()))
				removed = true
			}
		}
		if removed {
			apiTokensCache.mu.Lock()
			delete(apiTokensCache.tokens, token)
			apiTokensCache.mu.Unlock()
			metricsAdd("token_revoked")
		}

		responseWriter.Write([]byte("Revoked"))
		return true
	})

	myHTTPHandleFunc("/GetChallenges", requireMethod("POST"), requireToken, func(responseWriter http.ResponseWriter, request *http.Request) bool {

		// requireToken already validated the API Token, so we can just do this:
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")

		requestQuery := request.URL.Query()
		difficultyLevelString := requestQuery.Get("difficultyLevel")
		difficultyLevel, err := strconv.Atoi(difficultyLevelString)
		if err != nil {
			metricsAdd("challenges_bad_request")
			errorMessage := fmt.Sprintf(
				"400 url param ?difficultyLevel=%s value could not be converted to an integer",
				difficultyLevelString,
			)
			http.Error(responseWriter, errorMessage, http.StatusBadRequest)
			return true
		}

		challengesMu.Lock()
		if _, has := currentChallengesGeneration[token]; !has {
			currentChallengesGeneration[token] = 0
		}
		if _, has := challenges[token]; !has {
			challenges[token] = map[string]int{}
		}
		currentChallengesGeneration[token]++
		tokenChallenges := challenges[token]
		currentGeneration := currentChallengesGeneration[token]
		challengesMu.Unlock()

		cfg, argon := getRuntimeState()
		metricsAdd("challenge_batches")

		toReturn := make([]string, cfg.BatchSize)
		for i := 0; i < cfg.BatchSize; i++ {
			preimageBytes := make([]byte, 8)
			_, err := rand.Read(preimageBytes)
			if err != nil {
				metricsAdd("challenges_generate_error")
				log.Printf("read random bytes failed: %v", err)
				http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
				return true
			}
			preimage := base64.StdEncoding.EncodeToString(preimageBytes)
			difficultyBytes := make([]byte, int(math.Ceil(float64(difficultyLevel)/float64(8))))

			for j := 0; j < len(difficultyBytes); j++ {
				difficultyByte := byte(0)
				for k := 0; k < 8; k++ {
					currentBitIndex := (j*8 + (7 - k))
					if currentBitIndex+1 > difficultyLevel {
						difficultyByte = difficultyByte | 1<<k
					}
				}
				difficultyBytes[j] = difficultyByte
			}

			difficulty := hex.EncodeToString(difficultyBytes)
			challenge := Challenge{
				Preimage:        preimage,
				Difficulty:      difficulty,
				DifficultyLevel: difficultyLevel,
			}
			challenge.MemoryKiB = argon.MemoryKiB
			challenge.Iterations = argon.Iterations
			challenge.Parallelism = argon.Parallelism
			challenge.KeyLength = argon.KeyLength

			challengeBytes, err := json.Marshal(challenge)
			if err != nil {
				metricsAdd("challenges_generate_error")
				log.Printf("serialize challenge as json failed: %v", err)
				http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
				return true
			}

			challengeBase64 := base64.StdEncoding.EncodeToString(challengeBytes)
			challengesMu.Lock()
			tokenChallenges[challengeBase64] = currentGeneration
			challengesMu.Unlock()
			toReturn[i] = challengeBase64
		}
		toRemove := []string{}
		challengesMu.RLock()
		for k, generation := range tokenChallenges {
			if generation+cfg.DeprecateAfterBatches < currentGeneration {
				toRemove = append(toRemove, k)
			}
		}
		challengesMu.RUnlock()
		for _, k := range toRemove {
			challengesMu.Lock()
			delete(tokenChallenges, k)
			challengesMu.Unlock()
		}

		responseBytes, err := json.Marshal(toReturn)
		if err != nil {
			metricsAdd("challenges_generate_error")
			log.Printf("json marshal failed: %v", err)
			http.Error(responseWriter, "500 internal server error", http.StatusInternalServerError)
			return true
		}

		metricsAdd("challenges_generated", int64(len(toReturn)))

		responseWriter.Write(responseBytes)

		return true
	})

	myHTTPHandleFunc("/Verify", requireMethod("POST"), requireToken, func(responseWriter http.ResponseWriter, request *http.Request) bool {

		// requireToken already validated the API Token, so we can just do this:
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		metricsAdd("verify_requests")

		requestQuery := request.URL.Query()
		challengeBase64 := requestQuery.Get("challenge")
		nonceHex := requestQuery.Get("nonce")

		challengesMu.Lock()
		tokenChallenges, hasAnyChallenges := challenges[token]
		_, hasChallenge := tokenChallenges[challengeBase64]
		if !hasAnyChallenges || !hasChallenge {
			challengesMu.Unlock()
			metricsAdd("verify_not_found")
			errorMessage := fmt.Sprintf("404 challenge given by url param ?challenge=%s was not found", challengeBase64)
			http.Error(responseWriter, errorMessage, http.StatusNotFound)
			return true
		}
		delete(tokenChallenges, challengeBase64)
		challengesMu.Unlock()

		nonceBuffer := make([]byte, 8)
		bytesWritten, err := hex.Decode(nonceBuffer, []byte(nonceHex))
		if nonceHex == "" || err != nil {
			metricsAdd("verify_bad_nonce")
			errorMessage := fmt.Sprintf("400 bad request: nonce given by url param ?nonce=%s could not be hex decoded", nonceHex)
			http.Error(responseWriter, errorMessage, http.StatusBadRequest)
			return true
		}

		nonceBytes := nonceBuffer[:bytesWritten]

		challengeJSON, err := base64.StdEncoding.DecodeString(challengeBase64)
		if err != nil {
			log.Printf("challenge %s couldn't be parsed: %v\n", challengeBase64, err)
			http.Error(responseWriter, "500 challenge couldn't be decoded", http.StatusInternalServerError)
			return true
		}
		var challenge Challenge
		err = json.Unmarshal([]byte(challengeJSON), &challenge)
		if err != nil {
			log.Printf("challenge %s (%s) couldn't be parsed: %v\n", string(challengeJSON), challengeBase64, err)
			http.Error(responseWriter, "500 challenge couldn't be parsed", http.StatusInternalServerError)
			return true
		}

		preimageBytes := make([]byte, 8)
		n, err := base64.StdEncoding.Decode(preimageBytes, []byte(challenge.Preimage))
		if n != 8 || err != nil {
			metricsAdd("verify_invalid_preimage")
			log.Printf("invalid preimage %s: %v\n", challenge.Preimage, err)
			http.Error(responseWriter, "500 invalid preimage", http.StatusInternalServerError)
			return true
		}

		hash := argon2.IDKey(
			nonceBytes,
			preimageBytes,
			uint32(challenge.Iterations),
			uint32(challenge.MemoryKiB),
			uint8(challenge.Parallelism),
			uint32(challenge.KeyLength),
		)

		hashHex := hex.EncodeToString(hash)
		endOfHash := hashHex[len(hashHex)-len(challenge.Difficulty):]

		log.Printf("endOfHash: %s <= Difficulty: %s", endOfHash, challenge.Difficulty)
		if endOfHash > challenge.Difficulty {
			metricsAdd("verify_fail")
			errorMessage := fmt.Sprintf(
				"400 bad request: nonce given by url param ?nonce=%s did not result in a hash that meets the required difficulty",
				nonceHex,
			)
			http.Error(responseWriter, errorMessage, http.StatusBadRequest)
			return true
		}

		metricsAdd("verify_ok")
		responseWriter.WriteHeader(200)
		responseWriter.Write([]byte("OK"))
		return true
	})

	// Static assets for the frontend worker (served under /powdet/static)
	http.HandleFunc("/powdet/static/pow-bot-deterrent.css", func(responseWriter http.ResponseWriter, request *http.Request) {
		bytez, _ := os.ReadFile("./static/pow-bot-deterrent.css")
		responseWriter.Header().Set("Content-Type", "text/css")
		responseWriter.Write(bytez)
	})
	http.HandleFunc("/powdet/static/pow-bot-deterrent.js", func(responseWriter http.ResponseWriter, request *http.Request) {
		bytez, _ := os.ReadFile("./static/pow-bot-deterrent.js")
		responseWriter.Header().Set("Content-Type", "application/javascript")
		responseWriter.Write(bytez)
	})

	http.Handle("/powdet/static/", http.StripPrefix("/powdet/static/", http.FileServer(http.Dir("./static/"))))
	// Backward compatibility for older paths
	http.Handle("/pow-bot-deterrent-static/", http.StripPrefix("/pow-bot-deterrent-static/", http.FileServer(http.Dir("./static/"))))

	cfg := currentConfig()
	log.Printf("💥  PoW! Bot Deterrent server listening on port %d (configVersion=%s)", cfg.ListenPort, currentConfigVersion())

	err := http.ListenAndServe(fmt.Sprintf(":%d", cfg.ListenPort), nil)

	// if got this far it means server crashed!
	panic(err)
}

func myHTTPHandleFunc(path string, stack ...func(http.ResponseWriter, *http.Request) bool) {
	http.HandleFunc(path, func(responseWriter http.ResponseWriter, request *http.Request) {
		for _, handler := range stack {
			if handler(responseWriter, request) {
				break
			}
		}
	})
}

func locateAPITokensFolder() string {
	workingDirectory, err := os.Getwd()
	if err != nil {
		log.Fatalf("locateAPITokensFolder(): can't os.Getwd(): %v", err)
	}
	executableDirectory, err := getCurrentExecDir()
	if err != nil {
		log.Fatalf("locateAPITokensFolder(): can't getCurrentExecDir(): %v", err)
	}

	nextToExecutable := filepath.Join(executableDirectory, "PoW_Bot_Deterrent_API_Tokens")
	inWorkingDirectory := filepath.Join(workingDirectory, "PoW_Bot_Deterrent_API_Tokens")

	nextToExecutableStat, err := os.Stat(nextToExecutable)
	foundKeysNextToExecutable := err == nil && nextToExecutableStat.IsDir()
	inWorkingDirectoryStat, err := os.Stat(inWorkingDirectory)
	foundKeysInWorkingDirectory := err == nil && inWorkingDirectoryStat.IsDir()
	if foundKeysNextToExecutable && foundKeysInWorkingDirectory && workingDirectory != executableDirectory {
		log.Fatalf(`locateAPITokensFolder(): Something went wrong with your installation, 
			I found two PoW_Bot_Deterrent_API_Tokens folders and I'm not sure which one to use.
			One of them is located at %s
			and the other is at %s`, inWorkingDirectory, nextToExecutable)
	}
	if foundKeysInWorkingDirectory {
		return inWorkingDirectory
	} else if foundKeysNextToExecutable {
		return nextToExecutable
	}

	log.Fatalf(`locateAPITokensFolder(): I didn't find a PoW_Bot_Deterrent_API_Tokens folder 
		in the current working directory (in %s) or next to the executable (in %s)`, workingDirectory, executableDirectory)

	return ""
}

func getCurrentExecDir() (dir string, err error) {
	path, err := exec.LookPath(os.Args[0])
	if err != nil {
		fmt.Printf("exec.LookPath(%s) returned %s\n", os.Args[0], err)
		return "", err
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		fmt.Printf("filepath.Abs(%s) returned %s\n", path, err)
		return "", err
	}

	dir = filepath.Dir(absPath)

	return dir, nil
}

func loadAPITokens() error {
	tokens := map[string]struct{}{}
	fileInfos, err := ioutil.ReadDir(apiTokensFolder)
	if err != nil {
		return err
	}
	for _, fileInfo := range fileInfos {
		parts := strings.Split(fileInfo.Name(), "_")
		if len(parts) >= 1 && len(parts[0]) == 32 {
			tokens[parts[0]] = struct{}{}
		}
	}
	apiTokensCache.mu.Lock()
	apiTokensCache.tokens = tokens
	apiTokensCache.mu.Unlock()
	return nil
}

func tokenExists(token string) bool {
	apiTokensCache.mu.RLock()
	_, ok := apiTokensCache.tokens[token]
	apiTokensCache.mu.RUnlock()
	if ok {
		return true
	}
	// refresh once on miss (handles manual token file changes)
	if err := loadAPITokens(); err != nil {
		log.Printf("failed to reload API tokens: %v", err)
		return false
	}
	apiTokensCache.mu.RLock()
	_, ok = apiTokensCache.tokens[token]
	apiTokensCache.mu.RUnlock()
	return ok
}

func currentConfig() Config {
	configMu.RLock()
	cfg := config
	configMu.RUnlock()
	return cfg
}

func currentArgonParams() Argon2Parameters {
	configMu.RLock()
	params := argon2Parameters
	configMu.RUnlock()
	return params
}

func currentConfigVersion() string {
	configMu.RLock()
	version := configVersion
	configMu.RUnlock()
	return version
}

func getRuntimeState() (Config, Argon2Parameters) {
	configMu.RLock()
	cfg := config
	params := argon2Parameters
	configMu.RUnlock()
	return cfg, params
}

func (c controllerEnv) role() string {
	if strings.TrimSpace(c.Role) == "" {
		return "powdet"
	}
	return c.Role
}

func (c controllerEnv) enabled() bool {
	return strings.TrimSpace(c.URL) != "" && strings.TrimSpace(c.APIToken) != "" && strings.TrimSpace(c.Env) != ""
}

func (c controllerEnv) bootstrapURL() string {
	prefix := strings.Trim(c.APIPrefix, "/")
	if prefix == "" {
		prefix = "api/v0"
	}
	return strings.TrimSuffix(c.URL, "/") + "/" + prefix + "/bootstrap"
}

func (c controllerEnv) metricsURL() string {
	prefix := strings.Trim(c.APIPrefix, "/")
	if prefix == "" {
		prefix = "api/v0"
	}
	return strings.TrimSuffix(c.URL, "/") + "/" + prefix + "/metrics"
}

func newMetricsCounters() *metricsCounters {
	return &metricsCounters{counts: map[string]int64{}}
}

func (m *metricsCounters) inc(name string, delta int64) {
	if m == nil || delta == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counts[name] += delta
}

func (m *metricsCounters) snapshotAndReset() map[string]int64 {
	if m == nil {
		return map[string]int64{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	snapshot := make(map[string]int64, len(m.counts))
	for k, v := range m.counts {
		snapshot[k] = v
	}
	m.counts = map[string]int64{}
	return snapshot
}

func metricsAdd(name string, delta ...int64) {
	if metricsCollector == nil {
		return
	}
	step := int64(1)
	if len(delta) > 0 && delta[0] > 0 {
		step = delta[0]
	}
	metricsCollector.inc(name, step)
}

func collectMetricsSnapshot() metricsSnapshot {
	counts := map[string]int64{}
	if metricsCollector != nil {
		counts = metricsCollector.snapshotAndReset()
	}

	return metricsSnapshot{
		Timestamp:      time.Now().UnixMilli(),
		ConfigVersion:  currentConfigVersion(),
		Counts:         counts,
		ChallengeCache: countOutstandingChallenges(),
		TokenCount:     countAPITokens(),
	}
}

func countOutstandingChallenges() int {
	challengesMu.RLock()
	defer challengesMu.RUnlock()
	total := 0
	for _, tokenChallenges := range challenges {
		total += len(tokenChallenges)
	}
	return total
}

func countAPITokens() int {
	apiTokensCache.mu.RLock()
	defer apiTokensCache.mu.RUnlock()
	return len(apiTokensCache.tokens)
}

func startMetricsReporter() {
	metricsLoopOnce.Do(func() {
		reporter := newMetricsReporter(controllerSettings, runtimeInfo)
		if reporter == nil {
			return
		}
		metricsReporterInstance = reporter
		go reporter.loop()
	})
}

func newMetricsReporter(env controllerEnv, meta runtimeMeta) *metricsReporter {
	if !env.enabled() {
		return nil
	}
	if strings.TrimSpace(meta.env) == "" {
		return nil
	}
	if strings.TrimSpace(env.URL) == "" || strings.TrimSpace(env.APIToken) == "" {
		return nil
	}
	return &metricsReporter{
		env:      env,
		meta:     meta,
		client:   &http.Client{Timeout: 10 * time.Second},
		interval: 60 * time.Second,
	}
}

func (m *metricsReporter) loop() {
	if m == nil {
		return
	}
	sendOnce := func() {
		snap := collectMetricsSnapshot()
		if snap.empty() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := m.sendSnapshot(ctx, snap); err != nil {
			log.Printf("metrics flush failed: %v", err)
		}
		cancel()
	}

	sendOnce()
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for range ticker.C {
		sendOnce()
	}
}

func (m *metricsReporter) sendSnapshot(ctx context.Context, snap metricsSnapshot) error {
	if m == nil {
		return nil
	}
	if strings.TrimSpace(m.meta.env) == "" {
		return errors.New("env is required for metrics payload")
	}

	event := map[string]interface{}{
		"type":           "powdet.snapshot",
		"ts":             snap.Timestamp,
		"configVersion":  snap.ConfigVersion,
		"counts":         snap.Counts,
		"challengeCache": snap.ChallengeCache,
		"tokens":         snap.TokenCount,
	}
	if m.meta.appName != "" {
		event["appName"] = m.meta.appName
	}
	if m.meta.appVersion != "" {
		event["appVersion"] = m.meta.appVersion
	}
	if m.meta.role != "" {
		event["role"] = m.meta.role
	}
	if m.meta.instanceID != "" {
		event["instanceId"] = m.meta.instanceID
	}

	payload := map[string]interface{}{
		"source":      "powdet",
		"env":         m.meta.env,
		"instance_id": m.meta.instanceID,
		"events":      []map[string]interface{}{event},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.env.metricsURL(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+m.env.APIToken)

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("controller metrics failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	return nil
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func clearChallenges() {
	challengesMu.Lock()
	currentChallengesGeneration = map[string]int{}
	challenges = map[string]map[string]int{}
	challengesMu.Unlock()
}

func applyConfig(cfg Config, version string) error {
	normalized, params, err := normalizeConfig(cfg)
	if err != nil {
		return err
	}

	configMu.Lock()
	config = normalized
	argon2Parameters = params
	if strings.TrimSpace(version) == "" {
		configVersion = "local-config"
	} else {
		configVersion = version
	}
	configMu.Unlock()
	return nil
}

func normalizeConfig(cfg Config) (Config, Argon2Parameters, error) {
	cfg.ListenPort = intOrDefault(cfg.ListenPort, defaultListenPort)
	cfg.BatchSize = intOrDefault(cfg.BatchSize, defaultBatchSize)
	cfg.DeprecateAfterBatches = intOrDefault(cfg.DeprecateAfterBatches, defaultDeprecateAfterBatches)
	cfg.Argon2MemoryKiB = intOrDefault(cfg.Argon2MemoryKiB, defaultArgonMemoryKiB)
	cfg.Argon2Iterations = intOrDefault(cfg.Argon2Iterations, defaultArgonIterations)
	cfg.Argon2Parallelism = intOrDefault(cfg.Argon2Parallelism, defaultArgonParallelism)
	cfg.Argon2KeyLength = intOrDefault(cfg.Argon2KeyLength, defaultArgonKeyLength)

	if strings.TrimSpace(cfg.AdminAPIToken) == "" {
		return cfg, Argon2Parameters{}, fmt.Errorf("the POW_BOT_DETERRENT_ADMIN_API_TOKEN environment variable is required")
	}

	params := Argon2Parameters{
		MemoryKiB:   cfg.Argon2MemoryKiB,
		Iterations:  cfg.Argon2Iterations,
		Parallelism: cfg.Argon2Parallelism,
		KeyLength:   cfg.Argon2KeyLength,
	}

	return cfg, params, nil
}

func logEffectiveConfig(cfg Config, version string) {
	log.Printf("💥 PoW Bot Deterrent starting up with config (version=%s):", version)
	configToLogBytes, _ := json.MarshalIndent(cfg, "", "  ")
	configToLogString := regexp.MustCompile(
		`("admin_api_token": ")[^"]+(",)`,
	).ReplaceAllString(
		string(configToLogBytes),
		"$1******$2",
	)
	log.Println(configToLogString)
}

func readConfiguration() error {
	apiTokensFolder = locateAPITokensFolder()
	appDirectory = filepath.Dir(apiTokensFolder)

	var cfg Config
	var version string
	var err error

	configPath := filepath.Join(appDirectory, "config.json")
	cfgFromFile, meta, versionFromFile, err := loadConfigFromFile(configPath)
	if err != nil {
		return fmt.Errorf("load local config: %w", err)
	}

	controllerSettings = meta.Controller
	if strings.TrimSpace(controllerSettings.APIPrefix) == "" {
		controllerSettings.APIPrefix = "/api/v0"
	}
	internalAPIToken = meta.InternalAPIToken

	role := controllerSettings.role()
	runtimeInfo = runtimeMeta{
		appName:    defaultString(controllerSettings.AppName, "powdet"),
		appVersion: controllerSettings.AppVersion,
		env:        defaultString(controllerSettings.Env, "local"),
		role:       role,
		instanceID: defaultString(controllerSettings.InstanceID, role+"-local"),
	}

	if controllerSettings.enabled() {
		cfg, version, err = fetchConfigFromController(controllerSettings)
	} else {
		cfg, version = cfgFromFile, versionFromFile
	}
	if err != nil {
		if controllerSettings.enabled() {
			return fmt.Errorf("fetch controller config: %w", err)
		}
		return fmt.Errorf("load local config: %w", err)
	}

	if err := applyConfig(cfg, version); err != nil {
		return err
	}

	logEffectiveConfig(cfg, version)

	if err := loadAPITokens(); err != nil {
		return fmt.Errorf("failed to load API tokens from %s: %w", apiTokensFolder, err)
	}

	clearChallenges()

	return nil
}

func intOrDefault(v int, fallback int) int {
	if v <= 0 {
		return fallback
	}
	return v
}

func loadConfigFromFile(path string) (Config, fileConfigMeta, string, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fileConfigMeta{}, "", errors.Wrap(err, "read config file")
	}

	var meta fileConfigMeta
	_ = json.Unmarshal(data, &meta)

	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, meta, "", errors.Wrap(err, "decode config.json")
	}

	return cfg, meta, "local-config", nil
}

func fetchConfigFromController(ctrl controllerEnv) (Config, string, error) {
	if !ctrl.enabled() {
		return Config{}, "", fmt.Errorf("controller settings incomplete")
	}

	instanceID := ctrl.InstanceID
	if strings.TrimSpace(instanceID) == "" {
		instanceID = ctrl.role() + "-local"
	}

	payload := map[string]interface{}{
		"role":        ctrl.role(),
		"env":         ctrl.Env,
		"instance_id": instanceID,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return Config{}, "", err
	}

	req, err := http.NewRequest(http.MethodPost, ctrl.bootstrapURL(), strings.NewReader(string(body)))
	if err != nil {
		return Config{}, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+ctrl.APIToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Config{}, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		data, _ := ioutil.ReadAll(resp.Body)
		return Config{}, "", fmt.Errorf("controller bootstrap failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	var parsed struct {
		ConfigVersion string `json:"configVersion"`
		Powdet        *struct {
			Enabled               bool `json:"enabled"`
			ListenPort            int  `json:"listenPort"`
			BatchSize             int  `json:"batchSize"`
			DeprecateAfterBatches int  `json:"deprecateAfterBatches"`
			Argon2                struct {
				MemoryKiB   int `json:"memoryKiB"`
				Iterations  int `json:"iterations"`
				Parallelism int `json:"parallelism"`
				KeyLength   int `json:"keyLength"`
			} `json:"argon2"`
			AdminAPIToken string `json:"adminApiToken"`
		} `json:"powdet"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return Config{}, "", err
	}

	if parsed.Powdet == nil {
		return Config{}, "", fmt.Errorf("controller bootstrap missing powdet config")
	}
	if !parsed.Powdet.Enabled {
		return Config{}, "", fmt.Errorf("powdet config is disabled from controller")
	}

	cfg := Config{
		ListenPort:            parsed.Powdet.ListenPort,
		BatchSize:             parsed.Powdet.BatchSize,
		DeprecateAfterBatches: parsed.Powdet.DeprecateAfterBatches,
		Argon2MemoryKiB:       parsed.Powdet.Argon2.MemoryKiB,
		Argon2Iterations:      parsed.Powdet.Argon2.Iterations,
		Argon2Parallelism:     parsed.Powdet.Argon2.Parallelism,
		Argon2KeyLength:       parsed.Powdet.Argon2.KeyLength,
		AdminAPIToken:         parsed.Powdet.AdminAPIToken,
	}

	return cfg, parsed.ConfigVersion, nil
}

func registerInternalAPI() {
	http.HandleFunc("/api/v0/health", internalAuth(handleInternalHealth))
	http.HandleFunc("/api/v0/refresh", internalAuth(handleInternalRefresh))
	http.HandleFunc("/api/v0/flush", internalAuth(handleInternalFlush))
}

func internalAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimSpace(internalAPIToken) == "" {
			http.NotFound(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			http.NotFound(w, r)
			return
		}
		token := strings.TrimPrefix(auth, "Bearer ")
		if token != internalAPIToken {
			http.NotFound(w, r)
			return
		}
		next(w, r)
	}
}

func handleInternalHealth(w http.ResponseWriter, r *http.Request) {
	headers := w.Header()
	headers.Set("X-App-Name", runtimeInfo.appName)
	headers.Set("X-App-Version", runtimeInfo.appVersion)
	headers.Set("X-Env", runtimeInfo.env)
	headers.Set("X-Role", runtimeInfo.role)
	headers.Set("X-Instance-Id", runtimeInfo.instanceID)
	if version := currentConfigVersion(); version != "" {
		headers.Set("X-Config-Version", version)
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleInternalRefresh(w http.ResponseWriter, r *http.Request) {
	metricsAdd("refresh_requests")
	if err := readConfiguration(); err != nil {
		log.Printf("refresh config failed: %v", err)
		metricsAdd("refresh_failed")
		http.Error(w, "refresh failed", http.StatusBadGateway)
		return
	}
	metricsAdd("refresh_ok")
	w.WriteHeader(http.StatusNoContent)
}

func handleInternalFlush(w http.ResponseWriter, r *http.Request) {
	metricsAdd("flush_requests")
	snap := collectMetricsSnapshot()
	if metricsReporterInstance != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := metricsReporterInstance.sendSnapshot(ctx, snap); err != nil {
			log.Printf("flush metrics failed: %v", err)
			metricsAdd("flush_failed")
			cancel()
			http.Error(w, "flush failed", http.StatusBadGateway)
			return
		}
		cancel()
	}
	clearChallenges()
	if err := loadAPITokens(); err != nil {
		log.Printf("flush load API tokens failed: %v", err)
		metricsAdd("flush_failed")
		http.Error(w, "flush failed", http.StatusBadGateway)
		return
	}
	metricsAdd("flush_ok")
	w.WriteHeader(http.StatusNoContent)
}
