package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func sampleConfigTextForTests(t *testing.T) string {
	t.Helper()

	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config.yaml: %v", err)
	}

	return string(data)
}

func validConfigForTests(t *testing.T) *RootConfig {
	t.Helper()

	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	return cfg
}

func TestValidateRejectsUnknownThrottleProfileReference(t *testing.T) {
	cfg := validConfigForTests(t)
	cfg.Envs["staging"].Download.Paths.Profiles[0].Actions["throttleProfile"] = "missing"

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "unknown throttleProfile") {
		t.Fatalf("expected unknown throttleProfile error, got %v", err)
	}
}

func TestValidateRejectsEmptyThrottleProfileReference(t *testing.T) {
	cfg := validConfigForTests(t)
	cfg.Envs["staging"].Download.Paths.Profiles[0].Actions["throttleProfile"] = ""

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must not be empty") {
		t.Fatalf("expected empty throttleProfile error, got %v", err)
	}
}

func TestValidateRequiresDefaultThrottleProfile(t *testing.T) {
	cfg := validConfigForTests(t)
	delete(cfg.Envs["staging"].Download.ThrottleProfiles, "default")

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "download.throttleProfiles.default") {
		t.Fatalf("expected missing default throttle profile error, got %v", err)
	}
}

func TestValidateRejectsInvalidProtectHTTPCodes(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	profile := staging.Download.ThrottleProfiles["default"]
	profile.ProtectHTTPCodes = []int{429, 700}
	staging.Download.ThrottleProfiles["default"] = profile
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "protectHttpCodes") {
		t.Fatalf("expected invalid protectHttpCodes error, got %v", err)
	}
}

func TestValidateAppliesDownloadThrottleProfileDefaults(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	profile := staging.Download.ThrottleProfiles["default"]
	profile.OpenThresholdPercent = 0
	profile.CloseThresholdPercent = 0
	profile.MinSamplesBeforeEwmaOpen = 0
	profile.IdleResetSeconds = 0
	profile.HalfOpenSuccessThreshold = 0
	profile.HalfOpenCloseMode = ""
	profile.ProbeLeaseSeconds = 0
	profile.HalfOpenMaxSeconds = 0
	profile.HalfOpenTimeoutMode = ""
	staging.Download.ThrottleProfiles["default"] = profile
	cfg.Envs["staging"] = staging

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() failed: %v", err)
	}

	profile = cfg.Envs["staging"].Download.ThrottleProfiles["default"]
	if profile.OpenThresholdPercent != 30 {
		t.Fatalf("expected default openThresholdPercent 30, got %d", profile.OpenThresholdPercent)
	}
	if profile.CloseThresholdPercent != 15 {
		t.Fatalf("expected default closeThresholdPercent 15, got %d", profile.CloseThresholdPercent)
	}
	if profile.MinSamplesBeforeEwmaOpen != 8 {
		t.Fatalf("expected default minSamplesBeforeEwmaOpen 8, got %d", profile.MinSamplesBeforeEwmaOpen)
	}
	if profile.IdleResetSeconds != 900 {
		t.Fatalf("expected default idleResetSeconds 900, got %d", profile.IdleResetSeconds)
	}
	if profile.HalfOpenSuccessThreshold != 2 {
		t.Fatalf("expected default halfOpenSuccessThreshold 2, got %d", profile.HalfOpenSuccessThreshold)
	}
	if profile.HalfOpenCloseMode != "and" {
		t.Fatalf("expected default halfOpenCloseMode and, got %q", profile.HalfOpenCloseMode)
	}
	if profile.ProbeLeaseSeconds != 15 {
		t.Fatalf("expected default probeLeaseSeconds 15, got %d", profile.ProbeLeaseSeconds)
	}
	if profile.HalfOpenMaxSeconds != 0 {
		t.Fatalf("expected default halfOpenMaxSeconds 0, got %d", profile.HalfOpenMaxSeconds)
	}
	if profile.HalfOpenTimeoutMode != "partial-close" {
		t.Fatalf("expected default halfOpenTimeoutMode partial-close, got %q", profile.HalfOpenTimeoutMode)
	}
}

func TestValidateRejectsInvalidHalfOpenCloseMode(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	profile := staging.Download.ThrottleProfiles["default"]
	profile.HalfOpenCloseMode = "xor"
	staging.Download.ThrottleProfiles["default"] = profile
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "halfOpenCloseMode") {
		t.Fatalf("expected invalid halfOpenCloseMode error, got %v", err)
	}
}

func TestValidateRejectsInvalidHalfOpenTimeoutMode(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	profile := staging.Download.ThrottleProfiles["default"]
	profile.HalfOpenTimeoutMode = "linger"
	staging.Download.ThrottleProfiles["default"] = profile
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "halfOpenTimeoutMode") {
		t.Fatalf("expected invalid halfOpenTimeoutMode error, got %v", err)
	}
}

func TestValidateRequiresDownloadDefaultProfileID(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	staging.Download.Paths.Global.DefaultProfileID = ""
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "download.paths.global.defaultProfileId") {
		t.Fatalf("expected missing download defaultProfileId error, got %v", err)
	}
}

func TestValidateRequiresLandingDefaultProfileID(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	staging.Landing.Paths.Global.DefaultProfileID = ""
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "landing.paths.global.defaultProfileId") {
		t.Fatalf("expected missing landing defaultProfileId error, got %v", err)
	}
}

func TestValidateRejectsUnknownDownloadPathRuleProfileReference(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	staging.Download.Paths.Rules[0].ProfileID = "missing-profile"
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "download.paths.pathRules[0].profileId") {
		t.Fatalf("expected unknown download pathRules profileId error, got %v", err)
	}
}

func TestValidateRejectsUnknownLandingPathRuleProfileReference(t *testing.T) {
	cfg := validConfigForTests(t)
	staging := cfg.Envs["staging"]
	staging.Landing.Paths.Rules[0].ProfileID = "missing-profile"
	cfg.Envs["staging"] = staging

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "landing.paths.pathRules[0].profileId") {
		t.Fatalf("expected unknown landing pathRules profileId error, got %v", err)
	}
}

func TestLoadRejectsLegacyPathRuleFields(t *testing.T) {
	legacyFields := []struct {
		name  string
		value string
	}{
		{name: "prefix", value: `["/admin"]`},
		{name: "dirIncludes", value: `["admin"]`},
		{name: "nameIncludes", value: `["file"]`},
		{name: "pathIncludes", value: `["/admin/file"]`},
	}

	for _, legacy := range legacyFields {
		t.Run(legacy.name, func(t *testing.T) {
			original := sampleConfigTextForTests(t)
			mutated := strings.Replace(
				original,
				`          - pattern: "/admin/**"`,
				"          - pattern: \"/admin/**\"\n            "+legacy.name+": "+legacy.value,
				1,
			)
			if mutated == original {
				t.Fatalf("failed to inject legacy path rule field %s into config.yaml", legacy.name)
			}

			tmpPath := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
				t.Fatalf("write temp config: %v", err)
			}

			_, err := Load(tmpPath)
			if err == nil {
				t.Fatalf("expected Load to fail for legacy path rule field %s", legacy.name)
			}
			if !strings.Contains(err.Error(), legacy.name) {
				t.Fatalf("expected error to mention legacy path rule field %s, got %v", legacy.name, err)
			}
		})
	}
}

func TestLoadRejectsLegacyTopLevelLandingPathRulesBlock(t *testing.T) {
	original := sampleConfigTextForTests(t)
	mutated := strings.Replace(
		original,
		"      paths: # Landing path profile/rule schema；将静态动作收敛进 bootstrap",
		"      pathRules:\n        blacklist: []\n        whitelist: []\n        except: []\n      paths: # Landing path profile/rule schema；将静态动作收敛进 bootstrap",
		1,
	)
	if mutated == original {
		t.Fatalf("failed to inject legacy landing.pathRules block into config.yaml")
	}

	tmpPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}

	_, err := Load(tmpPath)
	if err == nil {
		t.Fatalf("expected Load to fail for legacy landing.pathRules block")
	}
	if !strings.Contains(err.Error(), "landing.pathRules") {
		t.Fatalf("expected error to mention landing.pathRules, got %v", err)
	}
}

func TestLoadRejectsLegacyTopLevelDownloadPathRulesBlock(t *testing.T) {
	original := sampleConfigTextForTests(t)
	mutated := strings.Replace(
		original,
		"      paths: # Download 侧 path profile/rule schema；决定 pathAction / FQ profile / throttle profile 等",
		"      pathRules:\n        blacklist: []\n        whitelist: []\n        except: []\n      paths: # Download 侧 path profile/rule schema；决定 pathAction / FQ profile / throttle profile 等",
		1,
	)
	if mutated == original {
		t.Fatalf("failed to inject legacy download.pathRules block into config.yaml")
	}

	tmpPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}

	_, err := Load(tmpPath)
	if err == nil {
		t.Fatalf("expected Load to fail for legacy download.pathRules block")
	}
	if !strings.Contains(err.Error(), "download.pathRules") {
		t.Fatalf("expected error to mention download.pathRules, got %v", err)
	}
}

func TestLoadRejectsLegacyDownloadThrottleProfileFields(t *testing.T) {
	legacyFields := []struct {
		name  string
		value string
	}{
		{name: "windowSeconds", value: "60"},
		{name: "observeWindowSeconds", value: "60"},
		{name: "errorRatioPercent", value: "20"},
		{name: "minSampleCount", value: "8"},
		{name: "fastErrorRatioPercent", value: "60"},
		{name: "fastMinSampleCount", value: "4"},
		{name: "cleanupPercentage", value: "1"},
		{name: "tableName", value: `"THROTTLE_PROTECTION"`},
	}

	for _, legacy := range legacyFields {
		t.Run(legacy.name, func(t *testing.T) {
			original := sampleConfigTextForTests(t)
			mutated := strings.Replace(
				original,
				"          hostPatterns: [] # Host patterns this throttle profile applies to; glob list",
				"          hostPatterns: [] # Host patterns this throttle profile applies to; glob list\n          "+legacy.name+": "+legacy.value,
				1,
			)
			if mutated == original {
				t.Fatalf("failed to inject legacy field %s into config.yaml", legacy.name)
			}

			tmpPath := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
				t.Fatalf("write temp config: %v", err)
			}

			_, err := Load(tmpPath)
			if err == nil {
				t.Fatalf("expected Load to fail for legacy throttle field %s", legacy.name)
			}
			if !strings.Contains(err.Error(), legacy.name) {
				t.Fatalf("expected error to mention legacy field %s, got %v", legacy.name, err)
			}
		})
	}
}

func TestDownloadThrottleProfileUnmarshalRejectsLegacyFieldsViaAliasNode(t *testing.T) {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte("hostPatterns: []\nwindowSeconds: 60\n"), &document); err != nil {
		t.Fatalf("unmarshal legacy profile node: %v", err)
	}
	if len(document.Content) == 0 {
		t.Fatalf("legacy profile document missing content")
	}

	alias := &yaml.Node{Kind: yaml.AliasNode, Alias: document.Content[0]}
	var profile DownloadThrottleProfile
	err := profile.UnmarshalYAML(alias)
	if err == nil {
		t.Fatalf("expected alias node to fail for legacy throttle fields")
	}
	if !strings.Contains(err.Error(), "windowSeconds") {
		t.Fatalf("expected alias-based error to mention windowSeconds, got %v", err)
	}
}
