package config

import (
	"errors"
	"fmt"
	"os"

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
	defaultAltchaTokenBindingTable  = "ALTCHA_TOKEN_LIST"
)

// CommonConfig holds shared upstream and auth settings.
type CommonConfig struct {
	AListBaseURL   string            `yaml:"alistBaseUrl" json:"alistBaseUrl"`
	AListAuth      map[string]string `yaml:"alistAuthHeaders" json:"alistAuthHeaders"`
	TokenHMACKeyID string            `yaml:"tokenHmacKeyId" json:"tokenHmacKeyId"`
	TokenHMACKey   string            `yaml:"tokenHmacKey" json:"tokenHmacKey"`
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

// LandingConfig describes landing-side static configuration.
type LandingConfig struct {
	PageSecret   string                 `yaml:"pageSecret" json:"pageSecret"`
	Captcha      LandingCaptchaConfig   `yaml:"captcha" json:"captcha"`
	Turnstile    LandingTurnstileConfig `yaml:"turnstile" json:"turnstile"`
	Altcha       LandingAltchaConfig    `yaml:"altcha" json:"altcha"`
	Powdet       LandingPowdetConfig    `yaml:"powdet" json:"powdet"`
	PathRules    DownloadPathRules      `yaml:"pathRules" json:"pathRules"`
	FastRedirect bool                   `yaml:"fastRedirect" json:"fastRedirect"`
	AutoRedirect bool                   `yaml:"autoRedirect" json:"autoRedirect"`
	Extra        map[string]any         `yaml:",inline" json:"-"`
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

// DownloadConfig collects download-side strategy and upstream config.
type DownloadConfig struct {
	Address              string                 `yaml:"address" json:"address"`
	DB                   map[string]any         `yaml:"db" json:"db"`
	FairQueue            map[string]any         `yaml:"fairQueue" json:"fairQueue"`
	ThrottleProfiles     map[string]any         `yaml:"throttleProfiles" json:"throttleProfiles"`
	OriginBindingDefault string                 `yaml:"originBindingDefault" json:"originBindingDefault"`
	PathRules            DownloadPathRules      `yaml:"pathRules" json:"pathRules"`
	Extra                map[string]interface{} `yaml:",inline" json:"-"`
}

// EnvConfig represents one environment such as prod or staging.
type EnvConfig struct {
	Common   CommonConfig   `yaml:"common" json:"common"`
	Landing  LandingConfig  `yaml:"landing" json:"landing"`
	Download DownloadConfig `yaml:"download" json:"download"`
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
		return nil, fmt.Errorf("parse config: %w", err)
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
	if e.Download.OriginBindingDefault == "" {
		return fmt.Errorf("download.originBindingDefault is required for env %s", envName)
	}

	if len(e.Landing.Captcha.DefaultCombo) == 0 {
		e.Landing.Captcha.DefaultCombo = []string{"verify-altcha"}
	}

	if e.Landing.PageSecret == "" {
		return fmt.Errorf("landing.pageSecret is required for env %s", envName)
	}

	if e.Landing.Turnstile.TokenTTLSeconds <= 0 {
		e.Landing.Turnstile.TokenTTLSeconds = 600
	}
	if e.Landing.Turnstile.CookieExpireSeconds <= 0 {
		e.Landing.Turnstile.CookieExpireSeconds = 120
	}
	if e.Landing.Turnstile.TokenTable == "" {
		e.Landing.Turnstile.TokenTable = "TURNSTILE_TOKEN_BINDING"
	}
	if e.Landing.Turnstile.ExpectedAction == "" {
		e.Landing.Turnstile.ExpectedAction = "download"
	}
	if e.Landing.Turnstile.Enabled {
		if e.Landing.Turnstile.SiteKey == "" || e.Landing.Turnstile.SecretKey == "" {
			return fmt.Errorf("landing.turnstile.siteKey/secretKey are required for env %s when turnstile.enabled is true", envName)
		}
	}

	if err := e.Landing.Altcha.ensureDefaults(); err != nil {
		return fmt.Errorf("landing.altcha invalid for env %s: %w", envName, err)
	}

	if err := e.Landing.Powdet.ensureDefaults(); err != nil {
		return fmt.Errorf("landing.powdet invalid for env %s: %w", envName, err)
	}

	if e.Landing.Powdet.Enabled {
		if e.Landing.Powdet.BaseURL == "" {
			return fmt.Errorf("landing.powdet.baseUrl is required for env %s when powdet.enabled is true", envName)
		}
		if e.Landing.Powdet.Token == "" {
			return fmt.Errorf("landing.powdet.token is required for env %s when powdet.enabled is true", envName)
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
