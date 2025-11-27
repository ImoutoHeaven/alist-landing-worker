package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	defaultAltchaDifficulty         = 250000
	defaultAltchaTokenExpireSeconds = 180
	defaultAltchaDifficultyWindow   = 30
	defaultAltchaDifficultyReset    = 120
	defaultAltchaMaxBlockSeconds    = 120
	defaultAltchaMaxExponent        = 10
	defaultAltchaMinUpgradeExponent = 3
	defaultPowdetExpireSeconds      = 180
	defaultPowdetClockSkewSeconds   = 60
	defaultPowdetMaxWindowSeconds   = 600
	defaultPowdetLevelStep          = 1
	defaultPowdetBaseLevelMin       = 12
	defaultPowdetBaseLevelMax       = 20
	defaultPowdetMaxLevel           = 4
	defaultPowdetDifficultyTable    = "POWDET_DIFFICULTY_STATE"
	defaultPowdetTicketTable        = "POW_CHALLENGE_TICKET"
	defaultPowdetListenPort         = 2370
	defaultPowdetBatchSize          = 1000
	defaultPowdetDeprecateBatches   = 10
	defaultPowdetArgonMemoryKiB     = 16384
	defaultPowdetArgonIterations    = 2
	defaultPowdetArgonParallelism   = 1
	defaultPowdetArgonKeyLength     = 16
	defaultAltchaTokenBindingTable  = "ALTCHA_TOKEN_LIST"
	defaultDownloadLinkTTLSeconds   = 1800
	defaultDownloadCleanupPercent   = 1.0
	defaultDownloadIdleTimeout      = 0
	defaultRateLimitIPv4Suffix      = "/32"
	defaultRateLimitIPv6Suffix      = "/60"
	defaultRateLimitBlockSeconds    = 600
	defaultThrottleObserveWindow    = 60
	defaultThrottleWindowSeconds    = 60
	defaultThrottleConsecutive      = 4
	defaultThrottleMinSampleCount   = 8
	defaultThrottleFastSampleCount  = 4
	defaultThrottleErrorRatioPct    = 20
	defaultThrottleFastErrorRatio   = 60
	defaultFairQueueWaitMs          = 15000
	defaultSlotHandlerTimeoutMs     = 20000
	defaultSlotHandlerPerReqTimeout = 8000
	defaultSlotHandlerAttemptsCap   = 35
	defaultLandingCleanupPercent    = 5.0
	defaultLandingCacheTTLSeconds   = 86400
	defaultLandingFileWindowSeconds = 60
	defaultLandingFileBlockSeconds  = 240
	defaultLandingIdleTimeout       = 0
	defaultLandingCryptFileHeader   = 32
	defaultLandingCryptBlockHeader  = 16
	defaultLandingCryptBlockData    = 64 * 1024
	defaultLandingWebMaxConn        = 16
	defaultLandingMinBandwidthMbps  = 10
	defaultLandingMinDurationSec    = 3600
	defaultSlotHandlerListen        = ":8080"
	defaultSlotHandlerAuthHeader    = "X-FQ-Auth"
	defaultSlotHandlerMaxWaitMs     = 20000
	defaultSlotHandlerPollInterval  = 500
	defaultSlotHandlerPollWindow    = 6000
	defaultSlotHandlerMaxSlotHost   = 5
	defaultSlotHandlerMaxSlotIP     = 1
	defaultSlotHandlerMaxWaitHost   = 50
	defaultSlotHandlerSessionIdle   = 90
	defaultSlotHandlerZombieTimeout = 30
	defaultSlotHandlerCleanupInt    = 1800
	defaultSlotHandlerQueueDepthTTL = 20
	defaultSlotHandlerCleanupDelay  = 5
	defaultSlotHandlerThrottleFunc  = "download_check_throttle_protection"
	defaultSlotHandlerRegisterFunc  = "download_register_fq_waiter"
	defaultSlotHandlerReleaseWaiter = "download_release_fq_waiter"
	defaultSlotHandlerTryAcquire    = "download_try_acquire_slot"
	defaultSlotHandlerReleaseSlot   = "download_release_slot"
)

func boolPtr(v bool) *bool {
	return &v
}

// CommonConfig holds shared upstream and auth settings.
type CommonConfig struct {
	AListBaseURL   string            `yaml:"alistBaseUrl" json:"alistBaseUrl"`
	AListAuth      map[string]string `yaml:"alistAuthHeaders" json:"alistAuthHeaders"`
	TokenHMACKeyID string            `yaml:"tokenHmacKeyId" json:"tokenHmacKeyId"`
	TokenHMACKey   string            `yaml:"tokenHmacKey" json:"tokenHmacKey"`
	SignSecret     string            `yaml:"signSecret" json:"signSecret"`
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

// LandingPowdetConfig holds powdet integration config.
type LandingPowdetConfig struct {
	Enabled          bool                        `yaml:"enabled" json:"enabled"`
	BaseURL          string                      `yaml:"baseUrl" json:"baseUrl"`
	StaticBaseURL    string                      `yaml:"staticBaseUrl" json:"staticBaseUrl"`
	Token            string                      `yaml:"token" json:"token"`
	Table            string                      `yaml:"table" json:"table"`
	DifficultyTable  string                      `yaml:"difficultyTable" json:"difficultyTable"`
	ExpireSeconds    int                         `yaml:"expireSeconds" json:"expireSeconds"`
	ClockSkewSeconds int                         `yaml:"clockSkewSeconds" json:"clockSkewSeconds"`
	MaxWindowSeconds int                         `yaml:"maxWindowSeconds" json:"maxWindowSeconds"`
	StaticLevel      *int                        `yaml:"staticLevel" json:"staticLevel"`
	Dynamic          *LandingPowdetDynamicConfig `yaml:"dynamic" json:"dynamic"`
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

// LandingAdditionalConfig groups misc landing behavior toggles.
type LandingAdditionalConfig struct {
	AppendAdditional   bool `yaml:"appendAdditional" json:"appendAdditional"`
	MinBandwidthMbps   int  `yaml:"minBandwidthMbps" json:"minBandwidthMbps"`
	MinDurationSeconds int  `yaml:"minDurationSeconds" json:"minDurationSeconds"`
	MaxDurationSeconds int  `yaml:"maxDurationSeconds" json:"maxDurationSeconds"`
}

// LandingConfig describes landing-side static configuration.
type LandingConfig struct {
	PageSecret           string                     `yaml:"pageSecret" json:"pageSecret"`
	Captcha              LandingCaptchaConfig       `yaml:"captcha" json:"captcha"`
	Turnstile            LandingTurnstileConfig     `yaml:"turnstile" json:"turnstile"`
	Altcha               LandingAltchaConfig        `yaml:"altcha" json:"altcha"`
	Powdet               LandingPowdetConfig        `yaml:"powdet" json:"powdet"`
	PathRules            DownloadPathRules          `yaml:"pathRules" json:"pathRules"`
	FastRedirect         bool                       `yaml:"fastRedirect" json:"fastRedirect"`
	AutoRedirect         bool                       `yaml:"autoRedirect" json:"autoRedirect"`
	IPv4Only             bool                       `yaml:"ipv4Only" json:"ipv4Only"`
	WorkerAddresses      []string                   `yaml:"workerAddresses" json:"workerAddresses"`
	DB                   LandingDBConfig            `yaml:"db" json:"db"`
	Crypt                LandingCryptConfig         `yaml:"crypt" json:"crypt"`
	WebDownloader        LandingWebDownloaderConfig `yaml:"webDownloader" json:"webDownloader"`
	ClientDecryptEnabled bool                       `yaml:"clientDecryptEnabled" json:"clientDecryptEnabled"`
	Additional           LandingAdditionalConfig    `yaml:"additional" json:"additional"`
	Extra                map[string]any             `yaml:",inline" json:"-"`
}

// PowdetServiceArgonConfig describes argon2 parameters for powdet service.
type PowdetServiceArgonConfig struct {
	MemoryKiB   int `yaml:"memoryKiB" json:"memoryKiB"`
	Iterations  int `yaml:"iterations" json:"iterations"`
	Parallelism int `yaml:"parallelism" json:"parallelism"`
	KeyLength   int `yaml:"keyLength" json:"keyLength"`
}

// PowdetServiceConfig holds controller-managed powdet settings.
type PowdetServiceConfig struct {
	Enabled               bool                     `yaml:"enabled" json:"enabled"`
	ListenPort            int                      `yaml:"listenPort" json:"listenPort"`
	BatchSize             int                      `yaml:"batchSize" json:"batchSize"`
	DeprecateAfterBatches int                      `yaml:"deprecateAfterBatches" json:"deprecateAfterBatches"`
	Argon2                PowdetServiceArgonConfig `yaml:"argon2" json:"argon2"`
	AdminAPIToken         string                   `yaml:"adminApiToken" json:"adminApiToken"`
	Extra                 map[string]any           `yaml:",inline" json:"-"`
}

// DownloadPathRule describes a single path rule.
type DownloadPathRule struct {
	Name         string   `yaml:"name" json:"name"`
	Prefix       []string `yaml:"prefix" json:"prefix"`
	DirIncludes  []string `yaml:"dirIncludes" json:"dirIncludes"`
	NameIncludes []string `yaml:"nameIncludes" json:"nameIncludes"`
	PathIncludes []string `yaml:"pathIncludes" json:"pathIncludes"`
	Action       []string `yaml:"action" json:"action"`
}

// DownloadPathRules groups blacklist/whitelist/except lists.
type DownloadPathRules struct {
	Blacklist []DownloadPathRule `yaml:"blacklist" json:"blacklist"`
	Whitelist []DownloadPathRule `yaml:"whitelist" json:"whitelist"`
	Except    []DownloadPathRule `yaml:"except" json:"except"`
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
	CacheTable         string                  `yaml:"cacheTable" json:"cacheTable"`
	LinkTTLSeconds     int                     `yaml:"linkTTLSeconds" json:"linkTTLSeconds"`
	CleanupPercentage  float64                 `yaml:"cleanupPercentage" json:"cleanupPercentage"`
	IdleTimeoutSeconds int                     `yaml:"idleTimeoutSeconds" json:"idleTimeoutSeconds"`
	LastActiveTable    string                  `yaml:"lastActiveTable" json:"lastActiveTable"`
	RateLimit          DownloadRateLimitConfig `yaml:"rateLimit" json:"rateLimit"`
	Extra              map[string]any          `yaml:",inline" json:"-"`
}

// DownloadThrottleProfile defines throttle v2 parameters.
type DownloadThrottleProfile struct {
	HostPatterns          []string `yaml:"hostPatterns" json:"hostPatterns"`
	WindowSeconds         int      `yaml:"windowSeconds" json:"windowSeconds"`
	ObserveWindowSeconds  int      `yaml:"observeWindowSeconds" json:"observeWindowSeconds"`
	ErrorRatioPercent     int      `yaml:"errorRatioPercent" json:"errorRatioPercent"`
	ConsecutiveThreshold  int      `yaml:"consecutiveThreshold" json:"consecutiveThreshold"`
	MinSampleCount        int      `yaml:"minSampleCount" json:"minSampleCount"`
	FastErrorRatioPercent int      `yaml:"fastErrorRatioPercent" json:"fastErrorRatioPercent"`
	FastMinSampleCount    int      `yaml:"fastMinSampleCount" json:"fastMinSampleCount"`
	ProtectHTTPCodes      []int    `yaml:"protectHttpCodes" json:"protectHttpCodes"`
	CleanupPercentage     float64  `yaml:"cleanupPercentage" json:"cleanupPercentage"`
	TableName             string   `yaml:"tableName" json:"tableName"`
}

// DownloadFairQueueProfile sets per-profile slot caps.
type DownloadFairQueueProfile struct {
	MaxWaitMs       int `yaml:"maxWaitMs" json:"maxWaitMs"`
	MaxSlotPerHost  int `yaml:"maxSlotPerHost" json:"maxSlotPerHost"`
	MaxSlotPerIP    int `yaml:"maxSlotPerIp" json:"maxSlotPerIp"`
	MaxWaitersPerIP int `yaml:"maxWaitersPerIp" json:"maxWaitersPerIp"`
}

// DownloadFairQueueConfig controls slot-handler integration.
type DownloadFairQueueConfig struct {
	Enabled              bool                                `yaml:"enabled" json:"enabled"`
	Backend              string                              `yaml:"backend" json:"backend"`
	HostPatterns         []string                            `yaml:"hostPatterns" json:"hostPatterns"`
	SlotHandlerURL       string                              `yaml:"slotHandlerUrl" json:"slotHandlerUrl"`
	SlotHandlerAuthKey   string                              `yaml:"slotHandlerAuthKey" json:"slotHandlerAuthKey"`
	QueueWaitTimeoutMs   int                                 `yaml:"queueWaitTimeoutMs" json:"queueWaitTimeoutMs"`
	SlotHandlerTimeoutMs int                                 `yaml:"slotHandlerTimeoutMs" json:"slotHandlerTimeoutMs"`
	PerRequestTimeoutMs  int                                 `yaml:"perRequestTimeoutMs" json:"perRequestTimeoutMs"`
	MaxAttemptsCap       int                                 `yaml:"maxAttemptsCap" json:"maxAttemptsCap"`
	Profiles             map[string]DownloadFairQueueProfile `yaml:"profiles" json:"profiles"`
	Extra                map[string]any                      `yaml:",inline" json:"-"`
}

// DownloadAuthConfig controls request integrity checks.
type DownloadAuthConfig struct {
	SignCheck               *bool  `yaml:"signCheck" json:"signCheck"`
	HashCheck               *bool  `yaml:"hashCheck" json:"hashCheck"`
	WorkerCheck             *bool  `yaml:"workerCheck" json:"workerCheck"`
	AdditionCheck           *bool  `yaml:"additionCheck" json:"additionCheck"`
	AdditionExpireTimeCheck *bool  `yaml:"additionExpireTimeCheck" json:"additionExpireTimeCheck"`
	IPv4Only                *bool  `yaml:"ipv4Only" json:"ipv4Only"`
	SignSecret              string `yaml:"signSecret" json:"signSecret"`
}

// DownloadConfig collects download-side strategy and upstream config.
type DownloadConfig struct {
	Address              string                             `yaml:"address" json:"address"`
	DB                   DownloadDBConfig                   `yaml:"db" json:"db"`
	FairQueue            DownloadFairQueueConfig            `yaml:"fairQueue" json:"fairQueue"`
	ThrottleProfiles     map[string]DownloadThrottleProfile `yaml:"throttleProfiles" json:"throttleProfiles"`
	OriginBindingDefault string                             `yaml:"originBindingDefault" json:"originBindingDefault"`
	PathRules            DownloadPathRules                  `yaml:"pathRules" json:"pathRules"`
	Auth                 DownloadAuthConfig                 `yaml:"auth" json:"auth"`
	Extra                map[string]interface{}             `yaml:",inline" json:"-"`
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
	ThrottleCheckFunc  string `yaml:"throttleCheckFunc" json:"throttleCheckFunc"`
	RegisterWaiterFunc string `yaml:"registerWaiterFunc" json:"registerWaiterFunc"`
	ReleaseWaiterFunc  string `yaml:"releaseWaiterFunc" json:"releaseWaiterFunc"`
	TryAcquireFunc     string `yaml:"tryAcquireFunc" json:"tryAcquireFunc"`
	ReleaseFunc        string `yaml:"releaseFunc" json:"releaseFunc"`
}

// SlotHandlerFairQueueCleanupConfig controls cleanup cadence.
type SlotHandlerFairQueueCleanupConfig struct {
	Enabled                    bool `yaml:"enabled" json:"enabled"`
	IntervalSeconds            int  `yaml:"intervalSeconds" json:"intervalSeconds"`
	QueueDepthZombieTtlSeconds int  `yaml:"queueDepthZombieTtlSeconds" json:"queueDepthZombieTtlSeconds"`
	enabledSet                 bool `yaml:"-" json:"-"`
	intervalSet                bool `yaml:"-" json:"-"`
}

// SlotHandlerFairQueueConfig matches slot-handler fair queue tuning.
type SlotHandlerFairQueueConfig struct {
	MaxWaitMs                  int64                             `yaml:"maxWaitMs" json:"maxWaitMs"`
	PollIntervalMs             int64                             `yaml:"pollIntervalMs" json:"pollIntervalMs"`
	PollWindowMs               int64                             `yaml:"pollWindowMs" json:"pollWindowMs"`
	MinSlotHoldMs              int64                             `yaml:"minSlotHoldMs" json:"minSlotHoldMs"`
	SmoothReleaseIntervalMs    *int64                            `yaml:"smoothReleaseIntervalMs" json:"smoothReleaseIntervalMs,omitempty"`
	SessionIdleSeconds         int                               `yaml:"sessionIdleSeconds" json:"sessionIdleSeconds"`
	MaxSlotPerHost             int                               `yaml:"maxSlotPerHost" json:"maxSlotPerHost"`
	MaxSlotPerIP               int                               `yaml:"maxSlotPerIp" json:"maxSlotPerIp"`
	MaxWaitersPerIP            int                               `yaml:"maxWaitersPerIp" json:"maxWaitersPerIp"`
	MaxWaitersPerHost          int                               `yaml:"maxWaitersPerHost" json:"maxWaitersPerHost"`
	ZombieTimeoutSeconds       int                               `yaml:"zombieTimeoutSeconds" json:"zombieTimeoutSeconds"`
	IPCooldownSeconds          int                               `yaml:"ipCooldownSeconds" json:"ipCooldownSeconds"`
	RPC                        SlotHandlerRPCConfig              `yaml:"rpc" json:"rpc"`
	Cleanup                    SlotHandlerFairQueueCleanupConfig `yaml:"cleanup" json:"cleanup"`
	DefaultGrantedCleanupDelay int                               `yaml:"defaultGrantedCleanupDelay" json:"defaultGrantedCleanupDelay"`
	maxWaitersPerHostSet       bool                              `yaml:"-" json:"-"`
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

func (f *SlotHandlerFairQueueConfig) UnmarshalYAML(value *yaml.Node) error {
	type raw SlotHandlerFairQueueConfig
	var aux raw
	if err := value.Decode(&aux); err != nil {
		return err
	}
	*f = SlotHandlerFairQueueConfig(aux)
	if value != nil && value.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(value.Content); i += 2 {
			key := strings.TrimSpace(value.Content[i].Value)
			if key == "maxWaitersPerHost" {
				f.maxWaitersPerHostSet = true
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

	for name, envCfg := range c.Envs {
		if err := envCfg.validate(name); err != nil {
			return err
		}
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

	if e.Download.OriginBindingDefault == "" {
		return fmt.Errorf("download.originBindingDefault is required for env %s", envName)
	}

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
	if c.Dynamic != nil {
		if c.Dynamic.WindowSeconds <= 0 {
			c.Dynamic.WindowSeconds = defaultPowdetClockSkewSeconds
		}
		if c.Dynamic.ResetSeconds <= 0 {
			c.Dynamic.ResetSeconds = defaultPowdetClockSkewSeconds * 5
		}
		if c.Dynamic.BlockSeconds < 0 {
			c.Dynamic.BlockSeconds = defaultPowdetClockSkewSeconds * 5
		}
		if c.Dynamic.BaseLevelMin <= 0 {
			c.Dynamic.BaseLevelMin = defaultPowdetBaseLevelMin
		}
		if c.Dynamic.BaseLevelMax < c.Dynamic.BaseLevelMin {
			c.Dynamic.BaseLevelMax = c.Dynamic.BaseLevelMin
		}
		if c.Dynamic.LevelStep <= 0 {
			c.Dynamic.LevelStep = defaultPowdetLevelStep
		}
		if c.Dynamic.MaxLevel < 0 {
			c.Dynamic.MaxLevel = defaultPowdetMaxLevel
		}
	}

	if c.StaticLevel != nil && *c.StaticLevel < 0 {
		value := defaultPowdetBaseLevelMin
		c.StaticLevel = &value
	}

	return nil
}

func (l *LandingConfig) ensureDefaults(envName string) error {
	if l.PageSecret == "" {
		return fmt.Errorf("landing.pageSecret is required for env %s", envName)
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

	l.Crypt.ensureDefaults()
	l.WebDownloader.ensureDefaults()
	l.Additional.ensureDefaults()

	if (l.WebDownloader.Enabled || l.ClientDecryptEnabled) && strings.TrimSpace(l.Crypt.DataKey) == "" {
		return fmt.Errorf("landing.crypt.dataKey is required for env %s when webDownloader or clientDecrypt is enabled", envName)
	}

	cleaned := make([]string, 0, len(l.WorkerAddresses))
	for _, addr := range l.WorkerAddresses {
		trimmed := strings.TrimSpace(addr)
		if trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	if len(cleaned) == 0 {
		return fmt.Errorf("landing.workerAddresses is required for env %s", envName)
	}
	l.WorkerAddresses = cleaned

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

func (a *LandingAdditionalConfig) ensureDefaults() {
	if a.MinBandwidthMbps <= 0 {
		a.MinBandwidthMbps = defaultLandingMinBandwidthMbps
	}
	if a.MinDurationSeconds <= 0 {
		a.MinDurationSeconds = defaultLandingMinDurationSec
	}
	if a.MaxDurationSeconds < 0 {
		a.MaxDurationSeconds = 0
	}
}

func (d *DownloadConfig) ensureDefaults(common CommonConfig, envName string) error {
	if d.Address == "" {
		return fmt.Errorf("download.address is required for env %s", envName)
	}

	if err := d.DB.ensureDefaults(envName); err != nil {
		return err
	}

	if err := d.ensureThrottleProfiles(); err != nil {
		return err
	}

	if err := d.FairQueue.ensureDefaults(envName); err != nil {
		return err
	}

	d.Auth.ensureDefaults(common)

	return nil
}

func (d *DownloadConfig) ensureThrottleProfiles() error {
	if d.ThrottleProfiles == nil {
		d.ThrottleProfiles = map[string]DownloadThrottleProfile{}
	}

	if _, ok := d.ThrottleProfiles["default"]; !ok {
		d.ThrottleProfiles["default"] = DownloadThrottleProfile{}
	}

	for name, profile := range d.ThrottleProfiles {
		profile.ensureDefaults()
		d.ThrottleProfiles[name] = profile
	}

	return nil
}

func (d *DownloadDBConfig) ensureDefaults(envName string) error {
	if d.Mode != "" && d.Mode != "custom-pg-rest" {
		return fmt.Errorf("download.db.mode must be \"\" or \"custom-pg-rest\" for env %s", envName)
	}

	if d.CacheTable == "" {
		d.CacheTable = "download_cache"
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
		d.LastActiveTable = "download_last_active"
	}

	d.RateLimit.ensureDefaults()
	if d.RateLimit.TableName == "" {
		d.RateLimit.TableName = "download_ip_ratelimit"
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
	if p.WindowSeconds <= 0 {
		p.WindowSeconds = defaultThrottleWindowSeconds
	}
	if p.ObserveWindowSeconds <= 0 {
		p.ObserveWindowSeconds = defaultThrottleObserveWindow
	}
	if p.ErrorRatioPercent <= 0 {
		p.ErrorRatioPercent = defaultThrottleErrorRatioPct
	}
	if p.FastErrorRatioPercent <= 0 {
		p.FastErrorRatioPercent = defaultThrottleFastErrorRatio
	}
	if p.FastErrorRatioPercent < p.ErrorRatioPercent {
		p.FastErrorRatioPercent = p.ErrorRatioPercent
	}
	if p.ConsecutiveThreshold <= 0 {
		p.ConsecutiveThreshold = defaultThrottleConsecutive
	}
	if p.MinSampleCount <= 0 {
		p.MinSampleCount = defaultThrottleMinSampleCount
	}
	if p.FastMinSampleCount < 0 {
		p.FastMinSampleCount = defaultThrottleFastSampleCount
	}
	if len(p.ProtectHTTPCodes) == 0 {
		p.ProtectHTTPCodes = []int{429, 499, 500, 502, 503, 504}
	}
	if p.CleanupPercentage < 0 {
		p.CleanupPercentage = defaultDownloadCleanupPercent
	}
	if p.TableName == "" {
		p.TableName = "download_throttle"
	}
}

func (f *DownloadFairQueueProfile) ensureDefaults(fallbackWait int) {
	if f.MaxWaitMs <= 0 {
		if fallbackWait > 0 {
			f.MaxWaitMs = fallbackWait
		} else {
			f.MaxWaitMs = defaultFairQueueWaitMs
		}
	}
	if f.MaxSlotPerHost <= 0 {
		f.MaxSlotPerHost = 8
	}
	if f.MaxSlotPerIP <= 0 {
		f.MaxSlotPerIP = 3
	}
	if f.MaxWaitersPerIP <= 0 {
		f.MaxWaitersPerIP = 8
	}
}

func (f *DownloadFairQueueConfig) ensureDefaults(envName string) error {
	if f.QueueWaitTimeoutMs <= 0 {
		f.QueueWaitTimeoutMs = defaultFairQueueWaitMs
	}
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
	if f.Profiles == nil {
		f.Profiles = map[string]DownloadFairQueueProfile{}
	}
	if _, ok := f.Profiles["default"]; !ok {
		f.Profiles["default"] = DownloadFairQueueProfile{}
	}
	for name, profile := range f.Profiles {
		profile.ensureDefaults(f.QueueWaitTimeoutMs)
		f.Profiles[name] = profile
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

func (a *DownloadAuthConfig) ensureDefaults(common CommonConfig) {
	if a.SignCheck == nil {
		a.SignCheck = boolPtr(true)
	}
	if a.HashCheck == nil {
		a.HashCheck = boolPtr(true)
	}
	if a.WorkerCheck == nil {
		a.WorkerCheck = boolPtr(true)
	}
	if a.AdditionCheck == nil {
		a.AdditionCheck = boolPtr(true)
	}
	if a.AdditionExpireTimeCheck == nil {
		a.AdditionExpireTimeCheck = boolPtr(true)
	}
	if a.IPv4Only == nil {
		a.IPv4Only = boolPtr(true)
	}
	if a.SignSecret == "" {
		a.SignSecret = common.SignSecret
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
	if p.Argon2.MemoryKiB <= 0 {
		p.Argon2.MemoryKiB = defaultPowdetArgonMemoryKiB
	}
	if p.Argon2.Iterations <= 0 {
		p.Argon2.Iterations = defaultPowdetArgonIterations
	}
	if p.Argon2.Parallelism <= 0 {
		p.Argon2.Parallelism = defaultPowdetArgonParallelism
	}
	if p.Argon2.KeyLength <= 0 {
		p.Argon2.KeyLength = defaultPowdetArgonKeyLength
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
	if c.QueueDepthZombieTtlSeconds <= 0 {
		c.QueueDepthZombieTtlSeconds = defaultSlotHandlerQueueDepthTTL
	}
	if !c.enabledSet {
		c.Enabled = true
	}
}

func (f *SlotHandlerFairQueueConfig) ensureDefaults() error {
	if f.MaxWaitMs <= 0 {
		f.MaxWaitMs = defaultSlotHandlerMaxWaitMs
	}
	if f.PollIntervalMs <= 0 {
		f.PollIntervalMs = defaultSlotHandlerPollInterval
	}
	if f.PollWindowMs <= 0 {
		f.PollWindowMs = defaultSlotHandlerPollWindow
	}
	if f.MinSlotHoldMs < 0 {
		f.MinSlotHoldMs = 0
	}
	if f.MaxSlotPerHost <= 0 {
		f.MaxSlotPerHost = defaultSlotHandlerMaxSlotHost
	}
	if f.MaxSlotPerIP <= 0 {
		f.MaxSlotPerIP = defaultSlotHandlerMaxSlotIP
	}
	if f.MaxWaitersPerIP < 0 {
		f.MaxWaitersPerIP = 0
	}
	if !f.maxWaitersPerHostSet && f.MaxWaitersPerHost <= 0 {
		f.MaxWaitersPerHost = defaultSlotHandlerMaxWaitHost
	}
	if f.SessionIdleSeconds <= 0 {
		f.SessionIdleSeconds = defaultSlotHandlerSessionIdle
	}
	if f.ZombieTimeoutSeconds <= 0 {
		f.ZombieTimeoutSeconds = defaultSlotHandlerZombieTimeout
	}
	if f.IPCooldownSeconds < 0 {
		f.IPCooldownSeconds = 0
	}
	if f.DefaultGrantedCleanupDelay <= 0 {
		f.DefaultGrantedCleanupDelay = defaultSlotHandlerCleanupDelay
	}

	if f.RPC.ThrottleCheckFunc == "" {
		f.RPC.ThrottleCheckFunc = defaultSlotHandlerThrottleFunc
	}
	if f.RPC.RegisterWaiterFunc == "" {
		f.RPC.RegisterWaiterFunc = defaultSlotHandlerRegisterFunc
	}
	if f.RPC.ReleaseWaiterFunc == "" {
		f.RPC.ReleaseWaiterFunc = defaultSlotHandlerReleaseWaiter
	}
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
