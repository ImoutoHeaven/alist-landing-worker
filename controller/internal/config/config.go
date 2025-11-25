package config

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
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

// LandingConfig describes landing-side static configuration.
type LandingConfig struct {
	Captcha      LandingCaptchaConfig  `yaml:"captcha" json:"captcha"`
	PathRules    DownloadPathRules     `yaml:"pathRules" json:"pathRules"`
	FastRedirect bool                  `yaml:"fastRedirect" json:"fastRedirect"`
	AutoRedirect bool                  `yaml:"autoRedirect" json:"autoRedirect"`
	Extra        map[string]any        `yaml:",inline" json:"-"`
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

	return nil
}
