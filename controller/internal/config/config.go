package config

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	defaultAltchaDifficulty                 = 250000
	defaultAltchaTokenExpireSeconds         = 180
	defaultAltchaDifficultyWindow           = 30
	defaultAltchaDifficultyReset            = 120
	defaultAltchaMaxBlockSeconds            = 120
	defaultAltchaMaxExponent                = 10
	defaultAltchaMinUpgradeExponent         = 3
	defaultPowdetExpireSeconds              = 180
	defaultPowdetClockSkewSeconds           = 60
	defaultPowdetMaxWindowSeconds           = 600
	defaultPowdetLevelStep                  = 1
	defaultPowdetBaseLevelMin               = 12
	defaultPowdetBaseLevelMax               = 20
	defaultPowdetMaxLevel                   = 4
	defaultPowdetDifficultyTable            = "POWDET_DIFFICULTY_STATE"
	defaultPowdetTicketTable                = "POW_CHALLENGE_TICKET"
	defaultPowdetListenPort                 = 2370
	defaultPowdetBatchSize                  = 1000
	defaultPowdetDeprecateBatches           = 10
	defaultPowdetArgonMemoryKiB             = 16384
	defaultPowdetArgonIterations            = 2
	defaultPowdetArgonParallelism           = 1
	defaultPowdetArgonKeyLength             = 16
	defaultPowdetRandomxSeedLen             = 32
	defaultPowdetRandomxCacheLRU            = 128
	defaultPowdetRandomxCacheTTL            = 600
	defaultAltchaTokenBindingTable          = "ALTCHA_TOKEN_LIST"
	defaultDownloadLinkTTLSeconds           = 1800
	defaultDownloadCleanupPercent           = 1.0
	defaultDownloadIdleTimeout              = 0
	defaultDownloadCacheOverrideMax         = "500MB"
	defaultRateLimitIPv4Suffix              = "/32"
	defaultRateLimitIPv6Suffix              = "/60"
	defaultBindingVersion                   = 1
	defaultBindingModes                     = "path,asn,country,iprange"
	defaultBindingIPv4Suffix                = "/32"
	defaultBindingIPv6Suffix                = "/60"
	defaultRateLimitBlockSeconds            = 600
	defaultThrottleOpenCapSeconds           = 60
	defaultThrottleOpenThresholdPercent     = 30
	defaultThrottleCloseThresholdPercent    = 15
	defaultThrottleEwmaSpan                 = 8
	defaultThrottleConsecutive              = 4
	defaultThrottleMinSamplesBeforeOpen     = 8
	defaultThrottleIdleResetSeconds         = 900
	defaultThrottleHalfOpenSuccessThreshold = 2
	defaultThrottleHalfOpenCloseMode        = "and"
	defaultThrottleProbeLeaseSeconds        = 15
	defaultThrottleHalfOpenMaxSeconds       = 0
	defaultThrottleHalfOpenTimeoutMode      = "partial-close"
	defaultSlotHandlerGraceMs               = 4000
	defaultSlotHandlerUtilWindowSec         = 10
	defaultSlotHandlerMaxBatch              = 8
	defaultSlotHandlerMaxProbePar           = 4
	defaultSlotHandlerMaxProbeQps           = 20
	defaultSlotHandlerMaxInFlightGlobal     = 300
	defaultSlotHandlerMaxInFlightHost       = 100
	defaultSlotHandlerMaxInFlightSite       = 50
	defaultSlotHandlerMaxInFlightIP         = 10
	defaultSlotHandlerTimeoutMs             = 20000
	defaultSlotHandlerPerReqTimeout         = 8000
	defaultSlotHandlerAttemptsCap           = 35
	defaultLandingCleanupPercent            = 5.0
	defaultLandingCacheTTLSeconds           = 86400
	defaultLandingFileWindowSeconds         = 60
	defaultLandingFileBlockSeconds          = 240
	defaultLandingIdleTimeout               = 0
	defaultLandingCryptFileHeader           = 32
	defaultLandingCryptBlockHeader          = 16
	defaultLandingCryptBlockData            = 64 * 1024
	defaultLandingWebMaxConn                = 16
	defaultLandingMinBandwidthMbps          = 10
	defaultLandingMinDurationSec            = 3600
	defaultLandingHrwMaxSize                = "500MB"
	defaultSlotHandlerListen                = ":8080"
	defaultSlotHandlerAuthHeader            = "X-FQ-Auth"
	defaultSlotHandlerPollInterval          = 500
	defaultSlotHandlerPollWindow            = 6000
	defaultSlotHandlerMaxSlotHost           = 5
	defaultSlotHandlerMaxSlotIP             = 1
	defaultSlotHandlerZombieTimeout         = 30
	defaultSlotHandlerCleanupInt            = 1800
	defaultSlotHandlerTryAcquire            = "fq_try_acquire_batch"
	defaultSlotHandlerReleaseSlot           = "fq_release_dual"
	defaultControllerListenAddr             = ":8080"
)

func boolPtr(v bool) *bool {
	return &v
}

func ensureIntPtr(ptr **int, fallback int) {
	if *ptr == nil {
		v := fallback
		*ptr = &v
		return
	}
	if **ptr < 0 {
		v := 0
		*ptr = &v
	}
}

func ensureInt64Ptr(ptr **int64, fallback int64) {
	if *ptr == nil {
		v := fallback
		*ptr = &v
		return
	}
	if **ptr < 0 {
		v := int64(0)
		*ptr = &v
	}
}

func normalizeAddressList(values []string) []string {
	cleaned := make([]string, 0, len(values))
	for _, addr := range values {
		trimmed := strings.TrimSpace(addr)
		if trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return cleaned
}

func normalizeSlotHandlerAuthHeaderName(value string) string {
	header := strings.TrimSpace(value)
	if strings.EqualFold(header, defaultSlotHandlerAuthHeader) {
		return defaultSlotHandlerAuthHeader
	}
	return header
}

func (b *BindingConfig) ensureDefaults() {
	if b.Version <= 0 {
		b.Version = defaultBindingVersion
	}
	if strings.TrimSpace(b.DefaultModes) == "" {
		b.DefaultModes = defaultBindingModes
	}
	if strings.TrimSpace(b.IPv4Suffix) == "" {
		b.IPv4Suffix = defaultBindingIPv4Suffix
	}
	if strings.TrimSpace(b.IPv6Suffix) == "" {
		b.IPv6Suffix = defaultBindingIPv6Suffix
	}
	if b.BindTLS == nil {
		b.BindTLS = boolPtr(true)
	}
}

// PathProfile describes a reusable action set for path matching.
type PathProfile struct {
	ID      string         `yaml:"id" json:"id"`
	Dynamic bool           `yaml:"dynamic" json:"dynamic"`
	Actions map[string]any `yaml:"actions" json:"actions"`
	Extra   map[string]any `yaml:",inline" json:"-"`
}

// PathRule maps an incoming path to a PathProfile.
// Pattern follows glob-like semantics; legacy prefix/includes matching is not supported.
type PathRule struct {
	Pattern   string         `yaml:"pattern" json:"pattern"`
	ProfileID string         `yaml:"profileId" json:"profileId"`
	Priority  int            `yaml:"priority,omitempty" json:"priority,omitempty"`
	Extra     map[string]any `yaml:",inline" json:"-"`
}

func (r *PathRule) UnmarshalYAML(value *yaml.Node) error {
	type raw PathRule
	var aux raw

	resolved, err := resolveYAMLNodeAliases(value)
	if err != nil {
		return err
	}

	if resolved != nil && resolved.Kind == yaml.MappingNode {
		allowed := map[string]struct{}{
			"pattern":   {},
			"profileId": {},
			"priority":  {},
		}
		for i := 0; i+1 < len(resolved.Content); i += 2 {
			key := strings.TrimSpace(resolved.Content[i].Value)
			if _, ok := allowed[key]; !ok {
				return fmt.Errorf("unknown path rule field %q", key)
			}
		}
	}

	if resolved == nil {
		return errors.New("path rule cannot be nil")
	}
	if err := resolved.Decode(&aux); err != nil {
		return err
	}

	*r = PathRule(aux)
	return nil
}

// PathGlobal carries path-level defaults.
type PathGlobal struct {
	DefaultProfileID  string         `yaml:"defaultProfileId" json:"defaultProfileId"`
	DecisionTimeoutMs *int           `yaml:"decisionTimeoutMs,omitempty" json:"decisionTimeoutMs,omitempty"`
	EnableFairQueue   *bool          `yaml:"enableFairQueue,omitempty" json:"enableFairQueue,omitempty"`
	Extra             map[string]any `yaml:",inline" json:"-"`
}

// PathConfig groups profiles, rules, and global defaults.
type PathConfig struct {
	Global   PathGlobal    `yaml:"global" json:"global"`
	Profiles []PathProfile `yaml:"pathProfiles" json:"pathProfiles"`
	Rules    []PathRule    `yaml:"pathRules" json:"pathRules"`
}

// CommonConfig holds shared upstream and auth settings.
type CommonConfig struct {
	AListBaseURL           string            `yaml:"alistBaseUrl" json:"alistBaseUrl"`
	AListAuth              map[string]string `yaml:"alistAuthHeaders" json:"alistAuthHeaders"`
	TokenHMACKeyID         string            `yaml:"tokenHmacKeyId" json:"tokenHmacKeyId"`
	TokenHMACKey           string            `yaml:"tokenHmacKey" json:"tokenHmacKey"`
	SignSecret             string            `yaml:"signSecret" json:"signSecret"`
	WorkerAddresses        []string          `yaml:"workerAddresses" json:"workerAddresses"`
	LandingWorkerAddresses []string          `yaml:"landingWorkerAddresses" json:"landingWorkerAddresses"`
	Binding                BindingConfig     `yaml:"binding" json:"binding"`
}

// BindingConfig controls binding string normalization defaults.
type BindingConfig struct {
	Version      int    `yaml:"version" json:"version"`
	DefaultModes string `yaml:"defaultModes" json:"defaultModes"`
	IPv4Suffix   string `yaml:"ipv4Suffix" json:"ipv4Suffix"`
	IPv6Suffix   string `yaml:"ipv6Suffix" json:"ipv6Suffix"`
	BindTLS      *bool  `yaml:"bindTls" json:"bindTls"`
}

// LandingCaptchaConfig carries captcha defaults for landing.
type LandingCaptchaConfig struct {
	DefaultCombo []string `yaml:"defaultCombo" json:"defaultCombo"`
}

// LandingTurnstileConfig holds Turnstile-related settings.
type LandingTurnstileConfig struct {
	Enabled             bool     `yaml:"enabled" json:"enabled"`
	SiteKey             string   `yaml:"siteKey" json:"siteKey"`
	SecretKey           string   `yaml:"secretKey" json:"secretKey"`
	RenderMode          string   `yaml:"renderMode" json:"renderMode"`
	TokenBinding        bool     `yaml:"tokenBinding" json:"tokenBinding"`
	TokenTTLSeconds     int      `yaml:"tokenTTLSeconds" json:"tokenTTLSeconds"`
	TokenTable          string   `yaml:"tokenTable" json:"tokenTable"`
	CookieExpireSeconds int      `yaml:"cookieExpireSeconds" json:"cookieExpireSeconds"`
	ExpectedAction      string   `yaml:"expectedAction" json:"expectedAction"`
	EnforceAction       bool     `yaml:"enforceAction" json:"enforceAction"`
	EnforceHostname     bool     `yaml:"enforceHostname" json:"enforceHostname"`
	AllowedHostnames    []string `yaml:"allowedHostnames" json:"allowedHostnames"`
}

// LandingAltchaConfig captures PoW configuration for landing.
type LandingAltchaConfig struct {
	Enabled                 bool   `yaml:"enabled" json:"enabled"`
	BaseDifficultyMin       int    `yaml:"baseDifficultyMin" json:"baseDifficultyMin"`
	BaseDifficultyMax       int    `yaml:"baseDifficultyMax" json:"baseDifficultyMax"`
	TokenExpireSeconds      int    `yaml:"tokenExpireSeconds" json:"tokenExpireSeconds"`
	TokenTable              string `yaml:"tokenTable" json:"tokenTable"`
	DifficultyWindowSeconds int    `yaml:"difficultyWindowSeconds" json:"difficultyWindowSeconds"`
	DifficultyResetSeconds  int    `yaml:"difficultyResetSeconds" json:"difficultyResetSeconds"`
	MaxBlockSeconds         int    `yaml:"maxBlockSeconds" json:"maxBlockSeconds"`
	MaxExponent             int    `yaml:"maxExponent" json:"maxExponent"`
	MinUpgradeExponent      int    `yaml:"minUpgradeExponent" json:"minUpgradeExponent"`
}

// LandingPowdetDynamicConfig describes adaptive difficulty for powdet.
type LandingPowdetDynamicConfig struct {
	WindowSeconds int `yaml:"windowSeconds" json:"windowSeconds"`
	ResetSeconds  int `yaml:"resetSeconds" json:"resetSeconds"`
	BlockSeconds  int `yaml:"blockSeconds" json:"blockSeconds"`
	BaseLevelMin  int `yaml:"baseLevelMin" json:"baseLevelMin"`
	BaseLevelMax  int `yaml:"baseLevelMax" json:"baseLevelMax"`
	LevelStep     int `yaml:"levelStep" json:"levelStep"`
	MaxLevel      int `yaml:"maxLevel" json:"maxLevel"`
}

// LandingPowdetAlgorithmConfig describes a single powdet algorithm config.
type LandingPowdetAlgorithmConfig struct {
	Enabled         bool                        `yaml:"enabled" json:"enabled"`
	StaticLevel     *int                        `yaml:"staticLevel" json:"staticLevel"`
	Dynamic         *LandingPowdetDynamicConfig `yaml:"dynamic" json:"dynamic"`
	DifficultyTable string                      `yaml:"difficultyTable" json:"difficultyTable"`
	StaticBaseURL   string                      `yaml:"staticBaseUrl" json:"staticBaseUrl"`
}

// LandingPowdetConfig holds powdet integration config.
type LandingPowdetConfig struct {
	Enabled          bool                                    `yaml:"enabled" json:"enabled"`
	BaseURL          string                                  `yaml:"baseUrl" json:"baseUrl"`
	StaticBaseURL    string                                  `yaml:"staticBaseUrl" json:"staticBaseUrl"`
	Token            string                                  `yaml:"token" json:"token"`
	Table            string                                  `yaml:"table" json:"table"`
	DifficultyTable  string                                  `yaml:"difficultyTable" json:"difficultyTable"`
	Algorithms       map[string]LandingPowdetAlgorithmConfig `yaml:"algorithms" json:"algorithms"`
	ExpireSeconds    int                                     `yaml:"expireSeconds" json:"expireSeconds"`
	ClockSkewSeconds int                                     `yaml:"clockSkewSeconds" json:"clockSkewSeconds"`
	MaxWindowSeconds int                                     `yaml:"maxWindowSeconds" json:"maxWindowSeconds"`
}

// LandingCacheConfig controls filesize cache settings.
type LandingCacheConfig struct {
	TableName         string  `yaml:"tableName" json:"tableName"`
	SizeTTLSeconds    int     `yaml:"sizeTTLSeconds" json:"sizeTTLSeconds"`
	CleanupPercentage float64 `yaml:"cleanupPercentage" json:"cleanupPercentage"`
}

func (c *LandingCacheConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw LandingCacheConfig
	aux := raw{
		CleanupPercentage: -1,
	}
	if err := value.Decode(&aux); err != nil {
		return err
	}
	*c = LandingCacheConfig(aux)
	return nil
}

// LandingRateLimitConfig describes landing-side rate limit parameters.
type LandingRateLimitConfig struct {
	Enabled           bool    `yaml:"enabled" json:"enabled"`
	WindowSeconds     int     `yaml:"windowSeconds" json:"windowSeconds"`
	Limit             int     `yaml:"limit" json:"limit"`
	IPv4Suffix        string  `yaml:"ipv4Suffix" json:"ipv4Suffix"`
	IPv6Suffix        string  `yaml:"ipv6Suffix" json:"ipv6Suffix"`
	BlockSeconds      int     `yaml:"blockSeconds" json:"blockSeconds"`
	PgErrorHandle     string  `yaml:"pgErrorHandle" json:"pgErrorHandle"`
	FileWindowSeconds int     `yaml:"fileWindowSeconds" json:"fileWindowSeconds"`
	FileLimit         int     `yaml:"fileLimit" json:"fileLimit"`
	FileBlockSeconds  int     `yaml:"fileBlockSeconds" json:"fileBlockSeconds"`
	TableName         string  `yaml:"tableName" json:"tableName"`
	FileTableName     string  `yaml:"fileTableName" json:"fileTableName"`
	CleanupPercentage float64 `yaml:"cleanupPercentage" json:"cleanupPercentage"`
}

func (r *LandingRateLimitConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw LandingRateLimitConfig
	aux := raw{
		CleanupPercentage: -1,
	}
	if err := value.Decode(&aux); err != nil {
		return err
	}
	*r = LandingRateLimitConfig(aux)
	return nil
}

// LandingDBConfig holds PostgREST and rate limit configuration.
type LandingDBConfig struct {
	Mode               string                 `yaml:"mode" json:"mode"`
	PostgrestURL       string                 `yaml:"postgrestUrl" json:"postgrestUrl"`
	VerifyHeader       []string               `yaml:"verifyHeader" json:"verifyHeader"`
	VerifySecret       []string               `yaml:"verifySecret" json:"verifySecret"`
	Cache              LandingCacheConfig     `yaml:"cache" json:"cache"`
	RateLimit          LandingRateLimitConfig `yaml:"rateLimit" json:"rateLimit"`
	IdleTable          string                 `yaml:"idleTable" json:"idleTable"`
	IdleTimeoutSeconds int                    `yaml:"idleTimeoutSeconds" json:"idleTimeoutSeconds"`
	CleanupPercentage  float64                `yaml:"cleanupPercentage" json:"cleanupPercentage"`
}

func (c *LandingDBConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw LandingDBConfig
	aux := raw{
		CleanupPercentage: -1,
	}
	if err := value.Decode(&aux); err != nil {
		return err
	}
	*c = LandingDBConfig(aux)
	return nil
}

// LandingCryptConfig captures crypt-related controls.
type LandingCryptConfig struct {
	Prefix          string   `yaml:"prefix" json:"prefix"`
	Includes        []string `yaml:"includes" json:"includes"`
	EncryptionMode  string   `yaml:"encryptionMode" json:"encryptionMode"`
	FileHeaderSize  int      `yaml:"fileHeaderSize" json:"fileHeaderSize"`
	BlockHeaderSize int      `yaml:"blockHeaderSize" json:"blockHeaderSize"`
	BlockDataSize   int      `yaml:"blockDataSize" json:"blockDataSize"`
	DataKey         string   `yaml:"dataKey" json:"dataKey"`
}

// LandingWebDownloaderConfig holds web downloader knobs.
type LandingWebDownloaderConfig struct {
	Enabled        bool `yaml:"enabled" json:"enabled"`
	MaxConnections int  `yaml:"maxConnections" json:"maxConnections"`
}

// LandingPayloadConfig groups payload expiration controls.
type LandingPayloadConfig struct {
	MinBandwidthMbps   int `yaml:"minBandwidthMbps" json:"minBandwidthMbps"`
	MinDurationSeconds int `yaml:"minDurationSeconds" json:"minDurationSeconds"`
	MaxDurationSeconds int `yaml:"maxDurationSeconds" json:"maxDurationSeconds"`
}

// LandingFrontendConfig describes landing page asset locations.
type LandingFrontendConfig struct {
	GlueUrl      string         `yaml:"glueUrl" json:"glueUrl"`
	HtmlUrl      string         `yaml:"htmlUrl" json:"htmlUrl"`
	CommonCssUrl string         `yaml:"commonCssUrl" json:"commonCssUrl"`
	ThemeCssUrl  string         `yaml:"themeCssUrl" json:"themeCssUrl"`
	Extra        map[string]any `yaml:",inline" json:"-"`
}

// LandingConfig describes landing-side static configuration.
type LandingConfig struct {
	PageSecret           string                     `yaml:"pageSecret" json:"pageSecret"`
	Frontend             LandingFrontendConfig      `yaml:"frontend" json:"frontend"`
	Captcha              LandingCaptchaConfig       `yaml:"captcha" json:"captcha"`
	CaptchaBinding       *BindingConfig             `yaml:"captchaBinding,omitempty" json:"captchaBinding,omitempty"`
	Turnstile            LandingTurnstileConfig     `yaml:"turnstile" json:"turnstile"`
	Altcha               LandingAltchaConfig        `yaml:"altcha" json:"altcha"`
	Powdet               LandingPowdetConfig        `yaml:"powdet" json:"powdet"`
	Paths                PathConfig                 `yaml:"paths" json:"paths"`
	FastRedirect         bool                       `yaml:"fastRedirect" json:"fastRedirect"`
	AutoRedirect         bool                       `yaml:"autoRedirect" json:"autoRedirect"`
	IPv4Only             bool                       `yaml:"ipv4Only" json:"ipv4Only"`
	DownloadWorkerHrw    bool                       `yaml:"downloadWorkerHrwEnabled" json:"downloadWorkerHrwEnabled"`
	DownloadWorkerHrwMax string                     `yaml:"downloadWorkerHrwMaxSize" json:"downloadWorkerHrwMaxSize"`
	DB                   LandingDBConfig            `yaml:"db" json:"db"`
	Crypt                LandingCryptConfig         `yaml:"crypt" json:"crypt"`
	WebDownloader        LandingWebDownloaderConfig `yaml:"webDownloader" json:"webDownloader"`
	ClientDecryptEnabled bool                       `yaml:"clientDecryptEnabled" json:"clientDecryptEnabled"`
	Payload              LandingPayloadConfig       `yaml:"payload" json:"payload"`
	Extra                map[string]any             `yaml:",inline" json:"-"`
}

func (l *LandingConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw LandingConfig
	var aux raw

	hasLegacyPathRules, err := hasYAMLMappingKey(value, "pathRules")
	if err != nil {
		return err
	}
	if hasLegacyPathRules {
		return errors.New("landing.pathRules is not supported; use landing.paths.pathRules")
	}

	resolved, err := resolveYAMLNodeAliases(value)
	if err != nil {
		return err
	}
	if resolved == nil {
		return errors.New("landing config cannot be nil")
	}
	if err := resolved.Decode(&aux); err != nil {
		return err
	}

	*l = LandingConfig(aux)
	return nil
}

// PowdetServiceAlgorithmConfig describes a powdet algorithm config.
type PowdetServiceAlgorithmConfig struct {
	Enabled bool `yaml:"enabled" json:"enabled"`
	// argon2id / argon2d
	MemoryKiB   int `yaml:"memoryKiB" json:"memoryKiB"`
	Iterations  int `yaml:"iterations" json:"iterations"`
	Parallelism int `yaml:"parallelism" json:"parallelism"`
	KeyLength   int `yaml:"keyLength" json:"keyLength"`
	// randomx
	V2           bool `yaml:"v2" json:"v2"`
	JIT          bool `yaml:"jit" json:"jit"`
	HardAes      bool `yaml:"hardAes" json:"hardAes"`
	LargePages   bool `yaml:"largePages" json:"largePages"`
	SeedLen      int  `yaml:"seedLen" json:"seedLen"`
	CacheLRUSize int  `yaml:"cacheLRUSize" json:"cacheLRUSize"`
	CacheTTL     int  `yaml:"cacheTTL" json:"cacheTTL"`
}

// PowdetServiceConfig holds controller-managed powdet settings.
type PowdetServiceConfig struct {
	Enabled               bool                                    `yaml:"enabled" json:"enabled"`
	ListenPort            int                                     `yaml:"listenPort" json:"listenPort"`
	BatchSize             int                                     `yaml:"batchSize" json:"batchSize"`
	DeprecateAfterBatches int                                     `yaml:"deprecateAfterBatches" json:"deprecateAfterBatches"`
	Algorithms            map[string]PowdetServiceAlgorithmConfig `yaml:"algorithms" json:"algorithms"`
	AdminAPIToken         string                                  `yaml:"adminApiToken" json:"adminApiToken"`
	Extra                 map[string]any                          `yaml:",inline" json:"-"`
}

// DownloadRateLimitConfig describes database-backed rate limit settings.
type DownloadRateLimitConfig struct {
	Enabled           bool    `yaml:"enabled" json:"enabled"`
	WindowSeconds     int     `yaml:"windowSeconds" json:"windowSeconds"`
	Limit             int     `yaml:"limit" json:"limit"`
	IPv4Suffix        string  `yaml:"ipv4Suffix" json:"ipv4Suffix"`
	IPv6Suffix        string  `yaml:"ipv6Suffix" json:"ipv6Suffix"`
	BlockSeconds      int     `yaml:"blockSeconds" json:"blockSeconds"`
	PgErrorHandle     string  `yaml:"pgErrorHandle" json:"pgErrorHandle"`
	TableName         string  `yaml:"tableName" json:"tableName"`
	CleanupPercentage float64 `yaml:"cleanupPercentage" json:"cleanupPercentage"`
}

// DownloadDBConfig collects PostgREST access and cache settings.
type DownloadDBConfig struct {
	Mode               string                  `yaml:"mode" json:"mode"`
	PostgrestURL       string                  `yaml:"postgrestUrl" json:"postgrestUrl"`
	VerifyHeader       []string                `yaml:"verifyHeader" json:"verifyHeader"`
	VerifySecret       []string                `yaml:"verifySecret" json:"verifySecret"`
	CacheEnabled       *bool                   `yaml:"cacheEnabled" json:"cacheEnabled"`
	CacheTable         string                  `yaml:"cacheTable" json:"cacheTable"`
	LinkTTLSeconds     int                     `yaml:"linkTTLSeconds" json:"linkTTLSeconds"`
	CleanupPercentage  float64                 `yaml:"cleanupPercentage" json:"cleanupPercentage"`
	IdleTimeoutSeconds int                     `yaml:"idleTimeoutSeconds" json:"idleTimeoutSeconds"`
	LastActiveTable    string                  `yaml:"lastActiveTable" json:"lastActiveTable"`
	RateLimit          DownloadRateLimitConfig `yaml:"rateLimit" json:"rateLimit"`
	Extra              map[string]any          `yaml:",inline" json:"-"`
}

// DownloadThrottleProfile defines the Stage 1 breaker profile contract.
type DownloadThrottleProfile struct {
	HostPatterns             []string `yaml:"hostPatterns" json:"hostPatterns"`
	OpenCapSeconds           int      `yaml:"openCapSeconds" json:"openCapSeconds"`
	OpenThresholdPercent     int      `yaml:"openThresholdPercent" json:"openThresholdPercent"`
	CloseThresholdPercent    int      `yaml:"closeThresholdPercent" json:"closeThresholdPercent"`
	EwmaSpan                 int      `yaml:"ewmaSpan" json:"ewmaSpan"`
	ConsecutiveThreshold     int      `yaml:"consecutiveThreshold" json:"consecutiveThreshold"`
	MinSamplesBeforeEwmaOpen int      `yaml:"minSamplesBeforeEwmaOpen" json:"minSamplesBeforeEwmaOpen"`
	IdleResetSeconds         int      `yaml:"idleResetSeconds" json:"idleResetSeconds"`
	HalfOpenSuccessThreshold int      `yaml:"halfOpenSuccessThreshold" json:"halfOpenSuccessThreshold"`
	HalfOpenCloseMode        string   `yaml:"halfOpenCloseMode" json:"halfOpenCloseMode"`
	ProbeLeaseSeconds        int      `yaml:"probeLeaseSeconds" json:"probeLeaseSeconds"`
	HalfOpenMaxSeconds       int      `yaml:"halfOpenMaxSeconds" json:"halfOpenMaxSeconds"`
	HalfOpenTimeoutMode      string   `yaml:"halfOpenTimeoutMode" json:"halfOpenTimeoutMode"`
	ProtectHTTPCodes         []int    `yaml:"protectHttpCodes" json:"protectHttpCodes"`
}

func (p *DownloadThrottleProfile) UnmarshalYAML(value *yaml.Node) error {
	type raw DownloadThrottleProfile
	var aux raw

	resolved, err := resolveYAMLNodeAliases(value)
	if err != nil {
		return err
	}

	if resolved != nil && resolved.Kind == yaml.MappingNode {
		allowed := map[string]struct{}{
			"hostPatterns":             {},
			"openCapSeconds":           {},
			"openThresholdPercent":     {},
			"closeThresholdPercent":    {},
			"ewmaSpan":                 {},
			"consecutiveThreshold":     {},
			"minSamplesBeforeEwmaOpen": {},
			"idleResetSeconds":         {},
			"halfOpenSuccessThreshold": {},
			"halfOpenCloseMode":        {},
			"probeLeaseSeconds":        {},
			"halfOpenMaxSeconds":       {},
			"halfOpenTimeoutMode":      {},
			"protectHttpCodes":         {},
		}
		for i := 0; i+1 < len(resolved.Content); i += 2 {
			key := strings.TrimSpace(resolved.Content[i].Value)
			if _, ok := allowed[key]; !ok {
				return fmt.Errorf("unknown download throttle profile field %q", key)
			}
		}
	}

	if resolved == nil {
		return errors.New("download throttle profile cannot be nil")
	}
	if err := resolved.Decode(&aux); err != nil {
		return err
	}

	*p = DownloadThrottleProfile(aux)
	return nil
}

func resolveYAMLNodeAliases(value *yaml.Node) (*yaml.Node, error) {
	seen := map[*yaml.Node]struct{}{}
	current := value
	for current != nil && current.Kind == yaml.AliasNode {
		if current.Alias == nil {
			return nil, errors.New("yaml alias missing target")
		}
		if _, ok := seen[current]; ok {
			return nil, errors.New("yaml alias cycle")
		}
		seen[current] = struct{}{}
		current = current.Alias
	}
	return current, nil
}

func hasYAMLMappingKey(value *yaml.Node, key string) (bool, error) {
	resolved, err := resolveYAMLNodeAliases(value)
	if err != nil {
		return false, err
	}
	if resolved == nil || resolved.Kind != yaml.MappingNode {
		return false, nil
	}

	for i := 0; i+1 < len(resolved.Content); i += 2 {
		if strings.TrimSpace(resolved.Content[i].Value) == key {
			return true, nil
		}
	}

	return false, nil
}

// DownloadFairQueueSiteBucketConfig controls site bucket derivation.
type DownloadFairQueueSiteBucketConfig struct {
	Mode string `yaml:"mode" json:"mode"`
}

// DownloadFairQueueConfig controls slot-handler integration.
type DownloadFairQueueConfig struct {
	Enabled               bool                              `yaml:"enabled" json:"enabled"`
	Backend               string                            `yaml:"backend" json:"backend"`
	HostPatterns          []string                          `yaml:"hostPatterns" json:"hostPatterns"`
	SlotHandlerURL        string                            `yaml:"slotHandlerUrl" json:"slotHandlerUrl"`
	SlotHandlerAuthKey    string                            `yaml:"slotHandlerAuthKey" json:"slotHandlerAuthKey"`
	SlotHandlerAuthHeader string                            `yaml:"slotHandlerAuthHeader" json:"slotHandlerAuthHeader"`
	SlotHandlerTimeoutMs  int                               `yaml:"slotHandlerTimeoutMs" json:"slotHandlerTimeoutMs"`
	PerRequestTimeoutMs   int                               `yaml:"perRequestTimeoutMs" json:"perRequestTimeoutMs"`
	MaxAttemptsCap        int                               `yaml:"maxAttemptsCap" json:"maxAttemptsCap"`
	SiteBucket            DownloadFairQueueSiteBucketConfig `yaml:"siteBucket" json:"siteBucket"`
	Extra                 map[string]any                    `yaml:",inline" json:"-"`
}

// DownloadAuthConfig controls request integrity checks.
type DownloadAuthConfig struct {
	IPv4Only *bool `yaml:"ipv4Only" json:"ipv4Only"`
}

// DownloadConfig collects download-side strategy and upstream config.
type DownloadConfig struct {
	Address              string                             `yaml:"address" json:"address"`
	DB                   DownloadDBConfig                   `yaml:"db" json:"db"`
	FairQueue            DownloadFairQueueConfig            `yaml:"fairQueue" json:"fairQueue"`
	ThrottleProfiles     map[string]DownloadThrottleProfile `yaml:"throttleProfiles" json:"throttleProfiles"`
	OriginBindingDefault string                             `yaml:"originBindingDefault" json:"originBindingDefault"`
	OverrideCacheControl bool                               `yaml:"override-cache-control" json:"overrideCacheControl"`
	CacheOverrideTime    string                             `yaml:"cache-override-time" json:"cacheOverrideTime"`
	CacheOverrideMaxSize string                             `yaml:"cache-override-max-size" json:"cacheOverrideMaxSize"`
	Paths                PathConfig                         `yaml:"paths" json:"paths"`
	Auth                 DownloadAuthConfig                 `yaml:"auth" json:"auth"`
	Extra                map[string]interface{}             `yaml:",inline" json:"-"`
}

func (d *DownloadConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw DownloadConfig
	var aux raw

	hasLegacyPathRules, err := hasYAMLMappingKey(value, "pathRules")
	if err != nil {
		return err
	}
	if hasLegacyPathRules {
		return errors.New("download.pathRules is not supported; use download.paths.pathRules")
	}

	resolved, err := resolveYAMLNodeAliases(value)
	if err != nil {
		return err
	}
	if resolved == nil {
		return errors.New("download config cannot be nil")
	}
	if err := resolved.Decode(&aux); err != nil {
		return err
	}

	*d = DownloadConfig(aux)
	return nil
}

// SlotHandlerAuthConfig guards slot-handler API.
type SlotHandlerAuthConfig struct {
	Enabled bool   `yaml:"enabled" json:"enabled"`
	Header  string `yaml:"header" json:"header"`
	Token   string `yaml:"token" json:"token"`
}

// SlotHandlerPostgrestConfig describes PostgREST backend settings.
type SlotHandlerPostgrestConfig struct {
	BaseURL    string `yaml:"baseUrl" json:"baseUrl"`
	AuthHeader string `yaml:"authHeader" json:"authHeader"`
}

// SlotHandlerPostgresConfig holds direct Postgres connection info.
type SlotHandlerPostgresConfig struct {
	DSN string `yaml:"dsn" json:"dsn"`
}

// SlotHandlerBackendConfig selects PostgREST/Postgres.
type SlotHandlerBackendConfig struct {
	Mode      string                     `yaml:"mode" json:"mode"`
	Postgrest SlotHandlerPostgrestConfig `yaml:"postgrest" json:"postgrest"`
	Postgres  SlotHandlerPostgresConfig  `yaml:"postgres" json:"postgres"`
	Extra     map[string]any             `yaml:",inline" json:"-"`
}

// SlotHandlerRPCConfig names fair queue RPC functions.
type SlotHandlerRPCConfig struct {
	TryAcquireFunc string `yaml:"tryAcquireFunc" json:"tryAcquireFunc"`
	ReleaseFunc    string `yaml:"releaseFunc" json:"releaseFunc"`
}

// SlotHandlerFairQueueCleanupConfig controls cleanup cadence.
type SlotHandlerFairQueueCleanupConfig struct {
	Enabled         bool `yaml:"enabled" json:"enabled"`
	IntervalSeconds int  `yaml:"intervalSeconds" json:"intervalSeconds"`
	enabledSet      bool `yaml:"-" json:"-"`
	intervalSet     bool `yaml:"-" json:"-"`
}

// SlotHandlerFairQueueConfig matches slot-handler fair queue tuning.
type SlotHandlerFairQueueConfig struct {
	PollIntervalMs          int64                             `yaml:"pollIntervalMs" json:"pollIntervalMs"`
	PollWindowMs            int64                             `yaml:"pollWindowMs" json:"pollWindowMs"`
	MinSlotHoldMs           int64                             `yaml:"minSlotHoldMs" json:"minSlotHoldMs"`
	SmoothReleaseIntervalMs *int64                            `yaml:"smoothReleaseIntervalMs" json:"smoothReleaseIntervalMs,omitempty"`
	GraceMs                 int64                             `yaml:"graceMs" json:"graceMs"`
	UtilWindowSec           int                               `yaml:"utilWindowSec" json:"utilWindowSec"`
	MaxBatch                int                               `yaml:"maxBatch" json:"maxBatch"`
	MaxProbeParallel        int                               `yaml:"maxProbeParallel" json:"maxProbeParallel"`
	MaxProbeQpsPerHost      int                               `yaml:"maxProbeQpsPerHost" json:"maxProbeQpsPerHost"`
	GlobalMaxInFlightFlow   *int                              `yaml:"globalMaxInFlightFlow" json:"globalMaxInFlightFlow,omitempty"`
	HostMaxInFlightFlow     *int                              `yaml:"hostMaxInFlightFlow" json:"hostMaxInFlightFlow,omitempty"`
	SiteMaxInFlightFlow     *int                              `yaml:"siteMaxInFlightFlow" json:"siteMaxInFlightFlow,omitempty"`
	IPBucketMaxInFlightFlow *int                              `yaml:"ipBucketMaxInFlightFlow" json:"ipBucketMaxInFlightFlow,omitempty"`
	ZombieTimeoutSeconds    int                               `yaml:"zombieTimeoutSeconds" json:"zombieTimeoutSeconds"`
	IPCooldownSeconds       int                               `yaml:"ipCooldownSeconds" json:"ipCooldownSeconds"`
	HostCaps                SlotHandlerHostCapsConfig         `yaml:"hostCaps" json:"hostCaps"`
	SiteCaps                SlotHandlerSiteCapsConfig         `yaml:"siteCaps" json:"siteCaps"`
	RPC                     SlotHandlerRPCConfig              `yaml:"rpc" json:"rpc"`
	Cleanup                 SlotHandlerFairQueueCleanupConfig `yaml:"cleanup" json:"cleanup"`
}

type SlotHandlerHostCapsConfig struct {
	MaxSlotPerHost *int `yaml:"maxSlotPerHost" json:"maxSlotPerHost,omitempty"`
	MaxSlotPerIP   *int `yaml:"maxSlotPerIp" json:"maxSlotPerIp,omitempty"`
}

type SlotHandlerSiteCapsConfig struct {
	MaxSlotPerSite *int `yaml:"maxSlotPerSite" json:"maxSlotPerSite,omitempty"`
	MaxSlotPerIP   *int `yaml:"maxSlotPerIp" json:"maxSlotPerIp,omitempty"`
}

// SlotHandlerConfig is the slot-handler bootstrap payload.
type SlotHandlerConfig struct {
	Listen    string                     `yaml:"listen" json:"listen"`
	LogLevel  string                     `yaml:"logLevel" json:"logLevel"`
	Auth      SlotHandlerAuthConfig      `yaml:"auth" json:"auth"`
	Backend   SlotHandlerBackendConfig   `yaml:"backend" json:"backend"`
	FairQueue SlotHandlerFairQueueConfig `yaml:"fairQueue" json:"fairQueue"`
	Extra     map[string]any             `yaml:",inline" json:"-"`
}

func (c *SlotHandlerFairQueueCleanupConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw SlotHandlerFairQueueCleanupConfig
	var aux raw
	if err := value.Decode(&aux); err != nil {
		return err
	}
	*c = SlotHandlerFairQueueCleanupConfig(aux)
	if value != nil && value.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(value.Content); i += 2 {
			key := strings.TrimSpace(value.Content[i].Value)
			switch key {
			case "enabled":
				c.enabledSet = true
			case "intervalSeconds":
				c.intervalSet = true
			}
		}
	}
	return nil
}

// EnvConfig represents one environment such as prod or staging.
type EnvConfig struct {
	Common      CommonConfig        `yaml:"common" json:"common"`
	Landing     LandingConfig       `yaml:"landing" json:"landing"`
	Download    DownloadConfig      `yaml:"download" json:"download"`
	Powdet      PowdetServiceConfig `yaml:"powdet" json:"powdet"`
	SlotHandler SlotHandlerConfig   `yaml:"slotHandler" json:"slotHandler"`
}

// RootConfig is the full controller configuration.
type RootConfig struct {
	ApiToken         string               `yaml:"apiToken" json:"apiToken"`
	BootstrapVersion string               `yaml:"bootstrapVersion" json:"bootstrapVersion"`
	RulesVersion     string               `yaml:"rulesVersion" json:"rulesVersion"`
	ListenAddr       string               `yaml:"listenAddr" json:"listenAddr"`
	Envs             map[string]EnvConfig `yaml:"envs" json:"envs"`
}

// Load reads YAML config and performs basic validation.
func Load(path string) (*RootConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg RootConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Validate ensures required fields exist.
func (c *RootConfig) Validate() error {
	if c.ApiToken == "" {
		return errors.New("apiToken is required")
	}
	if len(c.Envs) == 0 {
		return errors.New("envs is empty")
	}
	if strings.TrimSpace(c.ListenAddr) == "" {
		c.ListenAddr = defaultControllerListenAddr
	}

	for name, envCfg := range c.Envs {
		if err := envCfg.validate(name); err != nil {
			return err
		}
		c.Envs[name] = envCfg
	}

	return nil
}

func (e *EnvConfig) validate(envName string) error {
	if strings.TrimSpace(e.Common.TokenHMACKey) == "" {
		return fmt.Errorf("common.tokenHmacKey is required for env %s", envName)
	}
	if e.Common.TokenHMACKeyID == "" {
		e.Common.TokenHMACKeyID = "default"
	}
	if e.Common.SignSecret == "" {
		e.Common.SignSecret = e.Common.TokenHMACKey
	}
	e.Common.WorkerAddresses = normalizeAddressList(e.Common.WorkerAddresses)
	if len(e.Common.WorkerAddresses) == 0 {
		return fmt.Errorf("common.workerAddresses is required for env %s", envName)
	}
	e.Common.LandingWorkerAddresses = normalizeAddressList(e.Common.LandingWorkerAddresses)
	if len(e.Common.LandingWorkerAddresses) == 0 {
		return fmt.Errorf("common.landingWorkerAddresses is required for env %s", envName)
	}
	e.Common.Binding.ensureDefaults()

	e.Download.OriginBindingDefault = strings.TrimSpace(e.Download.OriginBindingDefault)

	if len(e.Landing.Captcha.DefaultCombo) == 0 {
		e.Landing.Captcha.DefaultCombo = []string{"verify-altcha"}
	}

	if err := e.Landing.ensureDefaults(envName); err != nil {
		return err
	}

	if err := e.Download.ensureDefaults(e.Common, envName); err != nil {
		return fmt.Errorf("download config invalid for env %s: %w", envName, err)
	}

	if err := e.Powdet.ensureDefaults(envName); err != nil {
		return fmt.Errorf("powdet config invalid for env %s: %w", envName, err)
	}

	if err := e.SlotHandler.ensureDefaults(envName); err != nil {
		return fmt.Errorf("slotHandler config invalid for env %s: %w", envName, err)
	}

	if e.Download.FairQueue.Enabled {
		if !e.SlotHandler.Auth.Enabled {
			return fmt.Errorf("slotHandler.auth.enabled must be true for env %s when download.fairQueue.enabled is true", envName)
		}
		if strings.TrimSpace(e.Download.FairQueue.SlotHandlerAuthKey) != strings.TrimSpace(e.SlotHandler.Auth.Token) {
			return fmt.Errorf("slotHandler.auth.token must match download.fairQueue.slotHandlerAuthKey for env %s", envName)
		}
		if !strings.EqualFold(e.Download.FairQueue.SlotHandlerAuthHeader, e.SlotHandler.Auth.Header) {
			return fmt.Errorf("slotHandler.auth.header must match download.fairQueue.slotHandlerAuthHeader for env %s", envName)
		}
	}

	return nil
}

func (c *LandingAltchaConfig) ensureDefaults() error {
	if c.BaseDifficultyMin <= 0 {
		c.BaseDifficultyMin = defaultAltchaDifficulty
	}
	if c.BaseDifficultyMax <= 0 {
		c.BaseDifficultyMax = c.BaseDifficultyMin
	}
	if c.BaseDifficultyMax < c.BaseDifficultyMin {
		c.BaseDifficultyMax = c.BaseDifficultyMin
	}
	if c.TokenExpireSeconds <= 0 {
		c.TokenExpireSeconds = defaultAltchaTokenExpireSeconds
	}
	if c.TokenTable == "" {
		c.TokenTable = defaultAltchaTokenBindingTable
	}
	if c.DifficultyWindowSeconds <= 0 {
		c.DifficultyWindowSeconds = defaultAltchaDifficultyWindow
	}
	if c.DifficultyResetSeconds <= 0 {
		c.DifficultyResetSeconds = defaultAltchaDifficultyReset
	}
	if c.MaxBlockSeconds < 0 {
		c.MaxBlockSeconds = defaultAltchaMaxBlockSeconds
	}
	if c.MaxExponent <= 0 {
		c.MaxExponent = defaultAltchaMaxExponent
	}
	if c.MinUpgradeExponent < 0 {
		c.MinUpgradeExponent = 0
	}
	maxUpgrade := c.MaxExponent - 1
	if maxUpgrade < 0 {
		maxUpgrade = 0
	}
	if c.MinUpgradeExponent == 0 && maxUpgrade > 0 {
		c.MinUpgradeExponent = defaultAltchaMinUpgradeExponent
	}
	if c.MinUpgradeExponent > maxUpgrade {
		c.MinUpgradeExponent = maxUpgrade
	}
	return nil
}

func (c *LandingPowdetConfig) ensureDefaults() error {
	if c.Table == "" {
		c.Table = defaultPowdetTicketTable
	}
	if c.DifficultyTable == "" {
		c.DifficultyTable = defaultPowdetDifficultyTable
	}
	if c.ExpireSeconds <= 0 {
		c.ExpireSeconds = defaultPowdetExpireSeconds
	}
	if c.ClockSkewSeconds <= 0 {
		c.ClockSkewSeconds = defaultPowdetClockSkewSeconds
	}
	if c.MaxWindowSeconds <= 0 {
		c.MaxWindowSeconds = defaultPowdetMaxWindowSeconds
	}
	if c.Enabled && len(c.Algorithms) == 0 {
		return fmt.Errorf("landing.powdet.algorithms must not be empty when powdet.enabled is true")
	}
	for name, algo := range c.Algorithms {
		if err := algo.ensureDefaults(c.DifficultyTable); err != nil {
			return fmt.Errorf("landing.powdet.algorithms.%s invalid: %w", name, err)
		}
		c.Algorithms[name] = algo
	}
	return nil
}

func (a *LandingPowdetAlgorithmConfig) ensureDefaults(defaultTable string) error {
	if a.DifficultyTable == "" {
		a.DifficultyTable = defaultTable
	}
	if a.Dynamic != nil {
		if a.Dynamic.WindowSeconds <= 0 {
			a.Dynamic.WindowSeconds = defaultPowdetClockSkewSeconds
		}
		if a.Dynamic.ResetSeconds <= 0 {
			a.Dynamic.ResetSeconds = defaultPowdetClockSkewSeconds * 5
		}
		if a.Dynamic.BlockSeconds < 0 {
			a.Dynamic.BlockSeconds = defaultPowdetClockSkewSeconds * 5
		}
		if a.Dynamic.BaseLevelMin <= 0 {
			a.Dynamic.BaseLevelMin = defaultPowdetBaseLevelMin
		}
		if a.Dynamic.BaseLevelMax < a.Dynamic.BaseLevelMin {
			a.Dynamic.BaseLevelMax = a.Dynamic.BaseLevelMin
		}
		if a.Dynamic.LevelStep <= 0 {
			a.Dynamic.LevelStep = defaultPowdetLevelStep
		}
		if a.Dynamic.MaxLevel < 0 {
			a.Dynamic.MaxLevel = defaultPowdetMaxLevel
		}
	}
	if a.StaticLevel != nil && *a.StaticLevel < 0 {
		value := defaultPowdetBaseLevelMin
		a.StaticLevel = &value
	}
	return nil
}

func (l *LandingConfig) ensureDefaults(envName string) error {
	if l.PageSecret == "" {
		return fmt.Errorf("landing.pageSecret is required for env %s", envName)
	}
	if strings.TrimSpace(l.Frontend.GlueUrl) == "" {
		return fmt.Errorf("landing.frontend.glueUrl is required for env %s", envName)
	}
	if strings.TrimSpace(l.Frontend.HtmlUrl) == "" {
		return fmt.Errorf("landing.frontend.htmlUrl is required for env %s", envName)
	}
	if strings.TrimSpace(l.Frontend.CommonCssUrl) == "" {
		return fmt.Errorf("landing.frontend.commonCssUrl is required for env %s", envName)
	}
	if strings.TrimSpace(l.Frontend.ThemeCssUrl) == "" {
		return fmt.Errorf("landing.frontend.themeCssUrl is required for env %s", envName)
	}

	if len(l.Paths.Profiles) == 0 {
		return fmt.Errorf("landing.paths.profiles must not be empty for env %s", envName)
	}
	if len(l.Paths.Rules) == 0 {
		return fmt.Errorf("landing.paths.rules must not be empty for env %s", envName)
	}
	if err := validatePathConfig("landing", &l.Paths); err != nil {
		return fmt.Errorf("%w for env %s", err, envName)
	}

	if l.Turnstile.TokenTTLSeconds <= 0 {
		l.Turnstile.TokenTTLSeconds = 600
	}
	if l.Turnstile.CookieExpireSeconds <= 0 {
		l.Turnstile.CookieExpireSeconds = 120
	}
	if l.Turnstile.TokenTable == "" {
		l.Turnstile.TokenTable = "TURNSTILE_TOKEN_BINDING"
	}
	if l.Turnstile.ExpectedAction == "" {
		l.Turnstile.ExpectedAction = "download"
	}
	turnstileMode := strings.ToLower(strings.TrimSpace(l.Turnstile.RenderMode))
	if turnstileMode == "" {
		l.Turnstile.RenderMode = "visible"
	} else if turnstileMode == "visible" || turnstileMode == "invisible" {
		l.Turnstile.RenderMode = turnstileMode
	} else {
		return fmt.Errorf("landing.turnstile.renderMode must be visible or invisible for env %s", envName)
	}
	if l.Turnstile.Enabled {
		if l.Turnstile.SiteKey == "" || l.Turnstile.SecretKey == "" {
			return fmt.Errorf("landing.turnstile.siteKey/secretKey are required for env %s when turnstile.enabled is true", envName)
		}
	}

	if err := l.Altcha.ensureDefaults(); err != nil {
		return fmt.Errorf("landing.altcha invalid for env %s: %w", envName, err)
	}

	if err := l.Powdet.ensureDefaults(); err != nil {
		return fmt.Errorf("landing.powdet invalid for env %s: %w", envName, err)
	}

	if l.Powdet.Enabled {
		if len(l.Powdet.Algorithms) == 0 {
			return fmt.Errorf("landing.powdet.algorithms is required for env %s when powdet.enabled is true", envName)
		}
		hasEnabledAlgo := false
		for _, algo := range l.Powdet.Algorithms {
			if algo.Enabled {
				hasEnabledAlgo = true
				break
			}
		}
		if !hasEnabledAlgo {
			return fmt.Errorf("landing.powdet.algorithms must enable at least one algorithm for env %s", envName)
		}
		if l.Powdet.BaseURL == "" {
			return fmt.Errorf("landing.powdet.baseUrl is required for env %s when powdet.enabled is true", envName)
		}
		if l.Powdet.Token == "" {
			return fmt.Errorf("landing.powdet.token is required for env %s when powdet.enabled is true", envName)
		}
	}

	if err := l.DB.ensureDefaults(envName); err != nil {
		return fmt.Errorf("landing.db invalid for env %s: %w", envName, err)
	}

	if l.CaptchaBinding != nil {
		l.CaptchaBinding.ensureDefaults()
	}

	l.Crypt.ensureDefaults()
	l.WebDownloader.ensureDefaults()
	l.Payload.ensureDefaults()

	if strings.TrimSpace(l.DownloadWorkerHrwMax) == "" {
		l.DownloadWorkerHrwMax = defaultLandingHrwMaxSize
	}
	if _, ok := parseCacheOverrideMaxSizeBytes(l.DownloadWorkerHrwMax); !ok {
		return fmt.Errorf("landing.downloadWorkerHrwMaxSize is invalid for env %s (expected <number>[B|KB|MB|GB])", envName)
	}

	if (l.WebDownloader.Enabled || l.ClientDecryptEnabled) && strings.TrimSpace(l.Crypt.DataKey) == "" {
		return fmt.Errorf("landing.crypt.dataKey is required for env %s when webDownloader or clientDecrypt is enabled", envName)
	}

	return nil
}

func (d *LandingDBConfig) ensureDefaults(envName string) error {
	if d.Mode != "" && d.Mode != "custom-pg-rest" {
		return fmt.Errorf("landing.db.mode must be \"\" or \"custom-pg-rest\" for env %s", envName)
	}

	if d.CleanupPercentage < 0 {
		d.CleanupPercentage = defaultLandingCleanupPercent
	}

	d.Cache.ensureDefaults(d.CleanupPercentage)
	d.RateLimit.ensureDefaults(d.CleanupPercentage)

	if d.IdleTimeoutSeconds < 0 {
		d.IdleTimeoutSeconds = defaultLandingIdleTimeout
	}
	if d.IdleTable == "" {
		d.IdleTable = "DOWNLOAD_LAST_ACTIVE_TABLE"
	}

	if d.Mode == "custom-pg-rest" {
		if d.PostgrestURL == "" {
			return fmt.Errorf("landing.db.postgrestUrl is required for env %s when mode=custom-pg-rest", envName)
		}
		if len(d.VerifyHeader) == 0 || len(d.VerifySecret) == 0 {
			return fmt.Errorf("landing.db.verifyHeader/verifySecret are required for env %s when mode=custom-pg-rest", envName)
		}
		if len(d.VerifyHeader) != len(d.VerifySecret) {
			return fmt.Errorf("landing.db.verifyHeader and verifySecret must have the same length for env %s", envName)
		}
	} else {
		d.RateLimit.Enabled = false
	}

	return nil
}

func (c *LandingCacheConfig) ensureDefaults(fallbackCleanup float64) {
	if c.TableName == "" {
		c.TableName = "FILESIZE_CACHE_TABLE"
	}
	if c.SizeTTLSeconds <= 0 {
		c.SizeTTLSeconds = defaultLandingCacheTTLSeconds
	}
	if c.CleanupPercentage < 0 {
		c.CleanupPercentage = fallbackCleanup
	}
	if c.CleanupPercentage < 0 {
		c.CleanupPercentage = defaultLandingCleanupPercent
	}
}

func (r *LandingRateLimitConfig) ensureDefaults(fallbackCleanup float64) {
	if r.IPv4Suffix == "" {
		r.IPv4Suffix = defaultRateLimitIPv4Suffix
	}
	if r.IPv6Suffix == "" {
		r.IPv6Suffix = defaultRateLimitIPv6Suffix
	}
	if r.BlockSeconds <= 0 {
		r.BlockSeconds = defaultRateLimitBlockSeconds
	}
	if r.FileWindowSeconds <= 0 {
		r.FileWindowSeconds = defaultLandingFileWindowSeconds
	}
	if r.FileLimit < 0 {
		r.FileLimit = 0
	}
	if r.FileBlockSeconds <= 0 {
		r.FileBlockSeconds = defaultLandingFileBlockSeconds
	}
	if r.TableName == "" {
		r.TableName = "IP_LIMIT_TABLE"
	}
	if r.FileTableName == "" {
		r.FileTableName = "IP_FILE_LIMIT_TABLE"
	}
	if r.CleanupPercentage < 0 {
		r.CleanupPercentage = fallbackCleanup
	}
	if r.CleanupPercentage < 0 {
		r.CleanupPercentage = defaultLandingCleanupPercent
	}
	r.PgErrorHandle = normalizePgErrorHandle(r.PgErrorHandle)
	if !r.Enabled || r.Limit <= 0 || r.WindowSeconds <= 0 {
		r.Enabled = false
	}
	if r.FileWindowSeconds <= 0 || r.FileLimit <= 0 {
		r.FileLimit = 0
		r.FileWindowSeconds = 0
	}
	if r.FileBlockSeconds < 0 {
		r.FileBlockSeconds = defaultLandingFileBlockSeconds
	}
}

func (c *LandingCryptConfig) ensureDefaults() {
	if c.EncryptionMode == "" {
		c.EncryptionMode = "crypt"
	}
	if c.FileHeaderSize <= 0 {
		c.FileHeaderSize = defaultLandingCryptFileHeader
	}
	if c.BlockHeaderSize <= 0 {
		c.BlockHeaderSize = defaultLandingCryptBlockHeader
	}
	if c.BlockDataSize <= 0 {
		c.BlockDataSize = defaultLandingCryptBlockData
	}
	if c.Includes == nil {
		c.Includes = []string{}
	}
}

func (w *LandingWebDownloaderConfig) ensureDefaults() {
	if w.MaxConnections <= 0 {
		w.MaxConnections = defaultLandingWebMaxConn
	}
}

func (p *LandingPayloadConfig) ensureDefaults() {
	if p.MinBandwidthMbps <= 0 {
		p.MinBandwidthMbps = defaultLandingMinBandwidthMbps
	}
	if p.MinDurationSeconds <= 0 {
		p.MinDurationSeconds = defaultLandingMinDurationSec
	}
	if p.MaxDurationSeconds < 0 {
		p.MaxDurationSeconds = 0
	}
}

func parseCacheOverrideSeconds(value string) (int, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) < 2 {
		return 0, false
	}

	unit := strings.ToLower(trimmed[len(trimmed)-1:])
	numberPart := strings.TrimSpace(trimmed[:len(trimmed)-1])
	if numberPart == "" {
		return 0, false
	}

	amount, err := strconv.ParseFloat(numberPart, 64)
	if err != nil || amount <= 0 {
		return 0, false
	}

	multiplier := 0.0
	switch unit {
	case "s":
		multiplier = 1
	case "m":
		multiplier = 60
	case "h":
		multiplier = 3600
	case "d":
		multiplier = 86400
	case "w":
		multiplier = 604800
	case "y":
		multiplier = 31536000
	default:
		return 0, false
	}

	seconds := amount * multiplier
	if seconds <= 0 {
		return 0, false
	}

	rounded := int(math.Round(seconds))
	if rounded <= 0 {
		return 0, false
	}

	return rounded, true
}

func parseCacheOverrideMaxSizeBytes(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}

	unit := ""
	numberPart := trimmed
	if len(trimmed) >= 2 {
		lastTwo := strings.ToUpper(trimmed[len(trimmed)-2:])
		if lastTwo == "KB" || lastTwo == "MB" || lastTwo == "GB" {
			unit = lastTwo
			numberPart = strings.TrimSpace(trimmed[:len(trimmed)-2])
		}
	}
	if unit == "" {
		lastOne := strings.ToUpper(trimmed[len(trimmed)-1:])
		if lastOne == "B" {
			unit = lastOne
			numberPart = strings.TrimSpace(trimmed[:len(trimmed)-1])
		}
	}

	if unit == "" || numberPart == "" {
		return 0, false
	}

	amount, err := strconv.ParseFloat(numberPart, 64)
	if err != nil || amount <= 0 {
		return 0, false
	}

	multiplier := float64(1)
	switch unit {
	case "KB":
		multiplier = 1024
	case "MB":
		multiplier = 1024 * 1024
	case "GB":
		multiplier = 1024 * 1024 * 1024
	case "B":
		multiplier = 1
	default:
		return 0, false
	}

	bytes := amount * multiplier
	if bytes <= 0 {
		return 0, false
	}

	rounded := int64(math.Round(bytes))
	if rounded <= 0 {
		return 0, false
	}

	return rounded, true
}

func (d *DownloadConfig) ensureDefaults(common CommonConfig, envName string) error {
	if d.Address == "" {
		return fmt.Errorf("download.address is required for env %s", envName)
	}

	if len(d.Paths.Profiles) == 0 {
		return fmt.Errorf("download.paths.profiles must not be empty for env %s", envName)
	}
	if len(d.Paths.Rules) == 0 {
		return fmt.Errorf("download.paths.rules must not be empty for env %s", envName)
	}
	if err := validatePathConfig("download", &d.Paths); err != nil {
		return fmt.Errorf("%w for env %s", err, envName)
	}

	if err := d.DB.ensureDefaults(envName); err != nil {
		return err
	}

	if err := d.ensureThrottleProfiles(envName); err != nil {
		return err
	}

	if err := d.FairQueue.ensureDefaults(envName); err != nil {
		return err
	}

	if strings.TrimSpace(d.CacheOverrideMaxSize) == "" {
		d.CacheOverrideMaxSize = defaultDownloadCacheOverrideMax
	}
	if _, ok := parseCacheOverrideMaxSizeBytes(d.CacheOverrideMaxSize); !ok {
		return fmt.Errorf("download.cacheOverrideMaxSize is invalid for env %s (expected <number>[B|KB|MB|GB])", envName)
	}

	if d.OverrideCacheControl {
		if strings.TrimSpace(d.CacheOverrideTime) == "" {
			return fmt.Errorf("download.cacheOverrideTime is required for env %s when override-cache-control is true", envName)
		}
		if _, ok := parseCacheOverrideSeconds(d.CacheOverrideTime); !ok {
			return fmt.Errorf("download.cacheOverrideTime is invalid for env %s (expected <number>[s|m|h|d|w|y])", envName)
		}
	}

	if strings.TrimSpace(d.OriginBindingDefault) == "" {
		d.OriginBindingDefault = strings.TrimSpace(common.Binding.DefaultModes)
	}

	d.Auth.ensureDefaults()

	return nil
}

func (d *DownloadConfig) ensureThrottleProfiles(envName string) error {
	if d.ThrottleProfiles == nil {
		return fmt.Errorf("download.throttleProfiles.default is required for env %s", envName)
	}

	if _, ok := d.ThrottleProfiles["default"]; !ok {
		return fmt.Errorf("download.throttleProfiles.default is required for env %s", envName)
	}

	for name, profile := range d.ThrottleProfiles {
		profile.ensureDefaults()
		if err := profile.validate(name); err != nil {
			return fmt.Errorf("download throttle profile %q invalid for env %s: %w", name, envName, err)
		}
		d.ThrottleProfiles[name] = profile
	}

	if err := d.validateThrottleProfileReferences(d.Paths.Profiles); err != nil {
		return err
	}

	return nil
}

func (d *DownloadConfig) validateThrottleProfileReferences(profiles []PathProfile) error {
	for _, profile := range profiles {
		if err := d.validateThrottleProfileReference(profile.ID, profile.Actions); err != nil {
			return err
		}
	}

	return nil
}

func (d *DownloadConfig) validateThrottleProfileReference(profileID string, actions map[string]any) error {
	if actions == nil {
		return nil
	}

	raw, ok := actions["throttleProfile"]
	if !ok || raw == nil {
		return nil
	}

	name, ok := raw.(string)
	if !ok {
		return fmt.Errorf("download path profile %q throttleProfile must be a string", profileID)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("download path profile %q throttleProfile must not be empty", profileID)
	}
	if _, ok := d.ThrottleProfiles[name]; !ok {
		return fmt.Errorf("unknown throttleProfile %q in download path profile %q", name, profileID)
	}

	return nil
}

func (d *DownloadDBConfig) ensureDefaults(envName string) error {
	if d.Mode != "" && d.Mode != "custom-pg-rest" {
		return fmt.Errorf("download.db.mode must be \"\" or \"custom-pg-rest\" for env %s", envName)
	}

	if d.CacheTable == "" {
		d.CacheTable = "DOWNLOAD_CACHE_TABLE"
	}
	if d.LinkTTLSeconds <= 0 {
		d.LinkTTLSeconds = defaultDownloadLinkTTLSeconds
	}
	if d.CleanupPercentage < 0 {
		d.CleanupPercentage = defaultDownloadCleanupPercent
	}
	if d.IdleTimeoutSeconds < 0 {
		d.IdleTimeoutSeconds = defaultDownloadIdleTimeout
	}
	if d.LastActiveTable == "" {
		d.LastActiveTable = "DOWNLOAD_LAST_ACTIVE_TABLE"
	}

	d.RateLimit.ensureDefaults()
	if d.RateLimit.TableName == "" {
		d.RateLimit.TableName = "DOWNLOAD_IP_RATELIMIT_TABLE"
	}
	if d.RateLimit.CleanupPercentage <= 0 {
		d.RateLimit.CleanupPercentage = d.CleanupPercentage
	}

	if d.Mode == "custom-pg-rest" {
		if d.PostgrestURL == "" {
			return fmt.Errorf("download.db.postgrestUrl is required for env %s when mode=custom-pg-rest", envName)
		}
		if len(d.VerifyHeader) == 0 || len(d.VerifySecret) == 0 {
			return fmt.Errorf("download.db.verifyHeader/verifySecret are required for env %s when mode=custom-pg-rest", envName)
		}
		if len(d.VerifyHeader) != len(d.VerifySecret) {
			return fmt.Errorf("download.db.verifyHeader and verifySecret must have the same length for env %s", envName)
		}
		if d.CacheEnabled == nil {
			return fmt.Errorf("download.db.cacheEnabled is required for env %s", envName)
		}

		if d.RateLimit.Enabled && (d.RateLimit.Limit <= 0 || d.RateLimit.WindowSeconds <= 0) {
			return fmt.Errorf("download.db.rateLimit requires positive windowSeconds and limit for env %s", envName)
		}
	}

	if d.Mode == "" {
		d.RateLimit.Enabled = false
	}

	return nil
}

func (r *DownloadRateLimitConfig) ensureDefaults() {
	if r.IPv4Suffix == "" {
		r.IPv4Suffix = defaultRateLimitIPv4Suffix
	}
	if r.IPv6Suffix == "" {
		r.IPv6Suffix = defaultRateLimitIPv6Suffix
	}
	if r.BlockSeconds <= 0 {
		r.BlockSeconds = defaultRateLimitBlockSeconds
	}
	if r.CleanupPercentage < 0 {
		r.CleanupPercentage = defaultDownloadCleanupPercent
	}
	r.PgErrorHandle = normalizePgErrorHandle(r.PgErrorHandle)
	if !r.Enabled || r.Limit <= 0 || r.WindowSeconds <= 0 {
		r.Enabled = false
	}
}

func (p *DownloadThrottleProfile) ensureDefaults() {
	if p.OpenCapSeconds <= 0 {
		p.OpenCapSeconds = defaultThrottleOpenCapSeconds
	}
	if p.OpenThresholdPercent <= 0 {
		p.OpenThresholdPercent = defaultThrottleOpenThresholdPercent
	}
	if p.CloseThresholdPercent <= 0 {
		p.CloseThresholdPercent = defaultThrottleCloseThresholdPercent
	}
	if p.EwmaSpan <= 0 {
		p.EwmaSpan = defaultThrottleEwmaSpan
	}
	if p.ConsecutiveThreshold <= 0 {
		p.ConsecutiveThreshold = defaultThrottleConsecutive
	}
	if p.MinSamplesBeforeEwmaOpen <= 0 {
		p.MinSamplesBeforeEwmaOpen = defaultThrottleMinSamplesBeforeOpen
	}
	if p.IdleResetSeconds <= 0 {
		p.IdleResetSeconds = defaultThrottleIdleResetSeconds
	}
	p.HalfOpenCloseMode = strings.TrimSpace(p.HalfOpenCloseMode)
	if p.HalfOpenSuccessThreshold <= 0 {
		p.HalfOpenSuccessThreshold = defaultThrottleHalfOpenSuccessThreshold
	}
	if p.HalfOpenCloseMode == "" {
		p.HalfOpenCloseMode = defaultThrottleHalfOpenCloseMode
	}
	if p.ProbeLeaseSeconds <= 0 {
		p.ProbeLeaseSeconds = defaultThrottleProbeLeaseSeconds
	}
	if p.HalfOpenMaxSeconds == 0 {
		p.HalfOpenMaxSeconds = defaultThrottleHalfOpenMaxSeconds
	}
	p.HalfOpenTimeoutMode = strings.TrimSpace(p.HalfOpenTimeoutMode)
	if p.HalfOpenTimeoutMode == "" {
		p.HalfOpenTimeoutMode = defaultThrottleHalfOpenTimeoutMode
	}
	if len(p.ProtectHTTPCodes) == 0 {
		p.ProtectHTTPCodes = []int{429, 499, 500, 502, 503, 504}
	}
}

func (p DownloadThrottleProfile) validate(name string) error {
	fieldPrefix := fmt.Sprintf("download.throttleProfiles.%s", name)

	for _, check := range []struct {
		field string
		value int
	}{
		{field: "openCapSeconds", value: p.OpenCapSeconds},
		{field: "openThresholdPercent", value: p.OpenThresholdPercent},
		{field: "closeThresholdPercent", value: p.CloseThresholdPercent},
		{field: "ewmaSpan", value: p.EwmaSpan},
		{field: "consecutiveThreshold", value: p.ConsecutiveThreshold},
		{field: "minSamplesBeforeEwmaOpen", value: p.MinSamplesBeforeEwmaOpen},
		{field: "idleResetSeconds", value: p.IdleResetSeconds},
		{field: "halfOpenSuccessThreshold", value: p.HalfOpenSuccessThreshold},
		{field: "probeLeaseSeconds", value: p.ProbeLeaseSeconds},
	} {
		if check.value <= 0 {
			return fmt.Errorf("%s.%s must be > 0", fieldPrefix, check.field)
		}
	}
	if p.HalfOpenMaxSeconds < 0 {
		return fmt.Errorf("%s.halfOpenMaxSeconds must be >= 0", fieldPrefix)
	}
	if p.HalfOpenCloseMode != "and" && p.HalfOpenCloseMode != "or" {
		return fmt.Errorf("%s.halfOpenCloseMode must be one of and, or", fieldPrefix)
	}
	if p.HalfOpenTimeoutMode != "open" && p.HalfOpenTimeoutMode != "close" && p.HalfOpenTimeoutMode != "partial-close" {
		return fmt.Errorf("%s.halfOpenTimeoutMode must be one of open, close, partial-close", fieldPrefix)
	}
	for idx, code := range p.ProtectHTTPCodes {
		if code < 100 || code > 599 {
			return fmt.Errorf("protectHttpCodes[%d] must be between 100 and 599, got %d", idx, code)
		}
	}

	return nil
}

func (f *DownloadFairQueueConfig) ensureDefaults(envName string) error {
	if f.SlotHandlerTimeoutMs <= 0 {
		f.SlotHandlerTimeoutMs = defaultSlotHandlerTimeoutMs
	}
	if f.PerRequestTimeoutMs <= 0 {
		f.PerRequestTimeoutMs = defaultSlotHandlerPerReqTimeout
	}
	if f.MaxAttemptsCap <= 0 {
		f.MaxAttemptsCap = defaultSlotHandlerAttemptsCap
	}
	if f.Backend == "" {
		f.Backend = "slot-handler"
	}
	f.SlotHandlerAuthHeader = normalizeSlotHandlerAuthHeaderName(f.SlotHandlerAuthHeader)
	if f.SlotHandlerAuthHeader == "" {
		f.SlotHandlerAuthHeader = defaultSlotHandlerAuthHeader
	}
	if strings.TrimSpace(f.SiteBucket.Mode) == "" {
		f.SiteBucket.Mode = "sharepoint"
	}

	if f.Enabled {
		if len(f.HostPatterns) == 0 {
			return fmt.Errorf("download.fairQueue.hostPatterns is required for env %s when fairQueue.enabled is true", envName)
		}
		if f.SlotHandlerURL == "" {
			return fmt.Errorf("download.fairQueue.slotHandlerUrl is required for env %s when fairQueue.enabled is true", envName)
		}
		if strings.TrimSpace(f.SlotHandlerAuthKey) == "" {
			return fmt.Errorf("download.fairQueue.slotHandlerAuthKey is required for env %s when fairQueue.enabled is true", envName)
		}
	}

	return nil
}

func (a *DownloadAuthConfig) ensureDefaults() {
	if a.IPv4Only == nil {
		a.IPv4Only = boolPtr(true)
	}
}

func (p *PowdetServiceConfig) ensureDefaults(envName string) error {
	if p.ListenPort == 0 {
		p.ListenPort = defaultPowdetListenPort
	}
	if p.BatchSize <= 0 {
		p.BatchSize = defaultPowdetBatchSize
	}
	if p.DeprecateAfterBatches <= 0 {
		p.DeprecateAfterBatches = defaultPowdetDeprecateBatches
	}
	if p.Enabled && len(p.Algorithms) == 0 {
		return fmt.Errorf("powdet.algorithms is required for env %s when powdet.enabled is true", envName)
	}
	hasEnabledAlgo := false
	for name, algo := range p.Algorithms {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "argon2id", "argon2d":
			if algo.MemoryKiB <= 0 {
				algo.MemoryKiB = defaultPowdetArgonMemoryKiB
			}
			if algo.Iterations <= 0 {
				algo.Iterations = defaultPowdetArgonIterations
			}
			if algo.Parallelism <= 0 {
				algo.Parallelism = defaultPowdetArgonParallelism
			}
			if algo.KeyLength <= 0 {
				algo.KeyLength = defaultPowdetArgonKeyLength
			}
		case "randomx":
			if algo.SeedLen <= 0 {
				algo.SeedLen = defaultPowdetRandomxSeedLen
			}
			if algo.SeedLen > 60 {
				return fmt.Errorf("powdet.algorithms.%s.seedLen must be <= 60 for env %s", name, envName)
			}
			if algo.CacheLRUSize <= 0 {
				algo.CacheLRUSize = defaultPowdetRandomxCacheLRU
			}
			if algo.CacheTTL <= 0 {
				algo.CacheTTL = defaultPowdetRandomxCacheTTL
			}
		}
		if algo.Enabled {
			hasEnabledAlgo = true
		}
		p.Algorithms[name] = algo
	}
	if p.Enabled && !hasEnabledAlgo {
		return fmt.Errorf("powdet.algorithms must enable at least one algorithm for env %s", envName)
	}
	if p.Enabled && strings.TrimSpace(p.AdminAPIToken) == "" {
		return fmt.Errorf("powdet.adminApiToken is required for env %s when powdet.enabled is true", envName)
	}

	return nil
}

func (c *SlotHandlerFairQueueCleanupConfig) ensureDefaults() {
	if !c.intervalSet || c.IntervalSeconds == 0 {
		c.IntervalSeconds = defaultSlotHandlerCleanupInt
	}
	if !c.enabledSet {
		c.Enabled = true
	}
}

func (f *SlotHandlerFairQueueConfig) ensureDefaults() error {
	if f.PollIntervalMs <= 0 {
		f.PollIntervalMs = defaultSlotHandlerPollInterval
	}
	if f.PollWindowMs <= 0 {
		f.PollWindowMs = defaultSlotHandlerPollWindow
	}
	if f.GraceMs <= 0 {
		f.GraceMs = defaultSlotHandlerGraceMs
	}
	if f.UtilWindowSec <= 0 {
		f.UtilWindowSec = defaultSlotHandlerUtilWindowSec
	}
	if f.MaxBatch <= 0 {
		f.MaxBatch = defaultSlotHandlerMaxBatch
	}
	if f.MaxProbeParallel <= 0 {
		f.MaxProbeParallel = defaultSlotHandlerMaxProbePar
	}
	if f.MaxProbeQpsPerHost <= 0 {
		f.MaxProbeQpsPerHost = defaultSlotHandlerMaxProbeQps
	}
	if f.MinSlotHoldMs < 0 {
		f.MinSlotHoldMs = 0
	}
	if f.ZombieTimeoutSeconds <= 0 {
		f.ZombieTimeoutSeconds = defaultSlotHandlerZombieTimeout
	}
	if f.IPCooldownSeconds < 0 {
		f.IPCooldownSeconds = 0
	}

	ensureIntPtr(&f.GlobalMaxInFlightFlow, defaultSlotHandlerMaxInFlightGlobal)
	ensureIntPtr(&f.HostMaxInFlightFlow, defaultSlotHandlerMaxInFlightHost)
	ensureIntPtr(&f.SiteMaxInFlightFlow, defaultSlotHandlerMaxInFlightSite)
	ensureIntPtr(&f.IPBucketMaxInFlightFlow, defaultSlotHandlerMaxInFlightIP)

	ensureIntPtr(&f.HostCaps.MaxSlotPerHost, defaultSlotHandlerMaxSlotHost)
	ensureIntPtr(&f.HostCaps.MaxSlotPerIP, defaultSlotHandlerMaxSlotIP)

	ensureIntPtr(&f.SiteCaps.MaxSlotPerSite, defaultSlotHandlerMaxSlotHost)
	ensureIntPtr(&f.SiteCaps.MaxSlotPerIP, defaultSlotHandlerMaxSlotIP)
	if f.RPC.TryAcquireFunc == "" {
		f.RPC.TryAcquireFunc = defaultSlotHandlerTryAcquire
	}
	if f.RPC.ReleaseFunc == "" {
		f.RPC.ReleaseFunc = defaultSlotHandlerReleaseSlot
	}

	f.Cleanup.ensureDefaults()
	return nil
}

func (b *SlotHandlerBackendConfig) ensureDefaults() error {
	if b.Mode == "" {
		b.Mode = "postgrest"
	}

	switch strings.ToLower(b.Mode) {
	case "postgrest":
		if strings.TrimSpace(b.Postgrest.BaseURL) == "" {
			return fmt.Errorf("slotHandler.backend.postgrest.baseUrl is required when mode=postgrest")
		}
	case "postgres":
		if strings.TrimSpace(b.Postgres.DSN) == "" {
			return fmt.Errorf("slotHandler.backend.postgres.dsn is required when mode=postgres")
		}
	default:
		return fmt.Errorf("slotHandler.backend.mode must be postgrest or postgres")
	}

	return nil
}

func (c *SlotHandlerConfig) ensureDefaults(envName string) error {
	if c.Listen == "" {
		c.Listen = defaultSlotHandlerListen
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	c.Auth.Header = normalizeSlotHandlerAuthHeaderName(c.Auth.Header)
	if c.Auth.Header == "" {
		c.Auth.Header = defaultSlotHandlerAuthHeader
	}
	if c.Auth.Enabled && strings.TrimSpace(c.Auth.Token) == "" {
		return fmt.Errorf("slotHandler.auth.token is required for env %s when auth.enabled is true", envName)
	}

	if err := c.Backend.ensureDefaults(); err != nil {
		return fmt.Errorf("slotHandler backend invalid for env %s: %w", envName, err)
	}
	if err := c.FairQueue.ensureDefaults(); err != nil {
		return fmt.Errorf("slotHandler fairQueue invalid for env %s: %w", envName, err)
	}

	return nil
}

func validatePathConfig(scope string, cfg *PathConfig) error {
	if cfg == nil {
		return fmt.Errorf("%s.paths is required", scope)
	}

	cfg.Global.DefaultProfileID = strings.TrimSpace(cfg.Global.DefaultProfileID)
	if cfg.Global.DefaultProfileID == "" {
		return fmt.Errorf("%s.paths.global.defaultProfileId is required", scope)
	}

	profileIDs := make(map[string]struct{}, len(cfg.Profiles))
	for i := range cfg.Profiles {
		cfg.Profiles[i].ID = strings.TrimSpace(cfg.Profiles[i].ID)
		if cfg.Profiles[i].ID == "" {
			return fmt.Errorf("%s.paths.pathProfiles[%d].id is required", scope, i)
		}
		if _, exists := profileIDs[cfg.Profiles[i].ID]; exists {
			return fmt.Errorf("%s.paths.pathProfiles[%d].id duplicates %q", scope, i, cfg.Profiles[i].ID)
		}
		profileIDs[cfg.Profiles[i].ID] = struct{}{}
	}

	if _, ok := profileIDs[cfg.Global.DefaultProfileID]; !ok {
		return fmt.Errorf("%s.paths.global.defaultProfileId %q does not match any pathProfiles[].id", scope, cfg.Global.DefaultProfileID)
	}

	for i := range cfg.Rules {
		cfg.Rules[i].ProfileID = strings.TrimSpace(cfg.Rules[i].ProfileID)
		if cfg.Rules[i].ProfileID == "" {
			return fmt.Errorf("%s.paths.pathRules[%d].profileId is required", scope, i)
		}
		if _, ok := profileIDs[cfg.Rules[i].ProfileID]; !ok {
			return fmt.Errorf("%s.paths.pathRules[%d].profileId %q does not match any pathProfiles[].id", scope, i, cfg.Rules[i].ProfileID)
		}
	}

	return nil
}

func ensurePathGlobal(global PathGlobal) PathGlobal {
	global.DefaultProfileID = strings.TrimSpace(global.DefaultProfileID)
	return global
}

// BuildPathSet returns global defaults, profiles, and rules for the given role.
// Only paths.* is supported.
func BuildPathSet(envCfg EnvConfig, role string) (PathGlobal, []PathProfile, []PathRule) {
	switch role {
	case "landing":
		global := ensurePathGlobal(envCfg.Landing.Paths.Global)
		return global, envCfg.Landing.Paths.Profiles, envCfg.Landing.Paths.Rules
	case "download":
		global := ensurePathGlobal(envCfg.Download.Paths.Global)
		return global, envCfg.Download.Paths.Profiles, envCfg.Download.Paths.Rules
	default:
		return PathGlobal{}, nil, nil
	}
}

func normalizePgErrorHandle(raw string) string {
	switch strings.ToLower(raw) {
	case "fail-open":
		return "fail-open"
	case "fail-closed":
		return "fail-closed"
	default:
		return "fail-closed"
	}
}
