package config

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func sampleConfigText(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config.yaml: %v", err)
	}
	return string(data)
}

func loadConfigFromText(t *testing.T, text string) (*RootConfig, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	return Load(path)
}

func extractIndentedBlock(block string, marker string) string {
	start := strings.Index(block, marker)
	if start < 0 {
		return ""
	}
	lines := strings.Split(block[start:], "\n")
	collected := make([]string, 0, len(lines))
	for idx, line := range lines {
		if idx > 0 {
			trimmed := strings.TrimSpace(line)
			indent := len(line) - len(strings.TrimLeft(line, " "))
			if trimmed != "" && indent <= 6 {
				break
			}
		}
		collected = append(collected, line)
	}
	return strings.Join(collected, "\n")
}

func extractFairQueueBlock(block string) string {
	return extractIndentedBlock(block, "      fairQueue:\n")
}

func extractTrueConcurrencyBlock(block string) string {
	return extractIndentedBlock(block, "      trueConcurrency:\n")
}

func replaceFirstIndentedBlock(text string, marker string, replacement string) string {
	start := strings.Index(text, marker)
	if start < 0 {
		return text
	}
	tail := text[start:]
	rest := extractIndentedBlock(tail, marker)
	if rest == "" {
		return text
	}
	end := start + len(rest)
	return text[:start] + replacement + text[end:]
}

func replaceFirstFairQueueBlock(text string, replacement string) string {
	return replaceFirstIndentedBlock(text, "      fairQueue:\n", replacement)
}

func replaceFirstTrueConcurrencyBlock(text string, replacement string) string {
	return replaceFirstIndentedBlock(text, "      trueConcurrency:\n", replacement)
}

func replaceFirstTrueConcurrencyBlockWithMergeTemplate(text string, templateName string, templateBody string) string {
	template := "      trueConcurrencyTemplate: &" + templateName + "\n" + templateBody
	merged := template + "      trueConcurrency:\n        <<: *" + templateName + "\n"
	return replaceFirstTrueConcurrencyBlock(text, merged)
}

func envSectionStart(text string, env string) int {
	return strings.Index(text, "  "+env+":")
}

func assertSiteBucketNormalized(t *testing.T, gotMode string, gotModes []string, wantMode string, wantModes []string) {
	t.Helper()
	if gotMode != wantMode {
		t.Fatalf("expected siteBucket.mode %q, got %q", wantMode, gotMode)
	}
	if !reflect.DeepEqual(gotModes, wantModes) {
		t.Fatalf("expected siteBucket.modes %+v, got %+v", wantModes, gotModes)
	}
}

// ensureSampleConfig decodes with all dynamic fields present (ALTCHA/Powdet).
func TestSampleConfigAlignment(t *testing.T) {
	assertIntPtrEq := func(name string, got *int, want int) {
		if got == nil || *got != want {
			t.Fatalf("slotHandler fairQueue %s not aligned: %v", name, got)
		}
	}

	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging, ok := cfg.Envs["staging"]
	if !ok {
		t.Fatalf("staging env missing in config.yaml")
	}

	altcha := staging.Landing.Altcha
	if altcha.DifficultyWindowSeconds == 0 || altcha.DifficultyResetSeconds == 0 {
		t.Fatalf("altcha dynamic fields not loaded: %+v", altcha)
	}
	if altcha.MaxExponent == 0 || altcha.MinUpgradeExponent < 0 {
		t.Fatalf("altcha exponent fields not loaded: %+v", altcha)
	}

	powdet := staging.Landing.Powdet
	if len(powdet.Algorithms) == 0 {
		t.Fatalf("powdet algorithms missing")
	}
	argon2id, ok := powdet.Algorithms["argon2id"]
	if !ok {
		t.Fatalf("powdet argon2id algorithm missing")
	}
	if argon2id.StaticLevel == nil {
		t.Fatalf("powdet argon2id staticLevel missing")
	}
	if argon2id.Dynamic == nil {
		t.Fatalf("powdet argon2id dynamic missing")
	}
	if argon2id.Dynamic.WindowSeconds == 0 || argon2id.Dynamic.ResetSeconds == 0 || argon2id.Dynamic.LevelStep == 0 {
		t.Fatalf("powdet argon2id dynamic fields incomplete: %+v", argon2id.Dynamic)
	}

	argon2d, ok := powdet.Algorithms["argon2d"]
	if !ok {
		t.Fatalf("powdet argon2d algorithm missing")
	}
	if argon2d.StaticLevel == nil {
		t.Fatalf("powdet argon2d staticLevel missing")
	}
	if argon2d.Dynamic == nil {
		t.Fatalf("powdet argon2d dynamic missing")
	}
	if argon2d.Dynamic.WindowSeconds == 0 || argon2d.Dynamic.ResetSeconds == 0 || argon2d.Dynamic.LevelStep == 0 {
		t.Fatalf("powdet argon2d dynamic fields incomplete: %+v", argon2d.Dynamic)
	}

	fairQueue := staging.SlotHandler.FairQueue
	if fairQueue.GraceMs != 4000 {
		t.Fatalf("slotHandler fairQueue graceMs not aligned: %d", fairQueue.GraceMs)
	}
	if fairQueue.RPC.TryAcquireFunc != "fq_admit_batch" {
		t.Fatalf("slotHandler fairQueue tryAcquireFunc not aligned: %q", fairQueue.RPC.TryAcquireFunc)
	}
	if fairQueue.RPC.ReleaseFunc != "fq_release_dual" {
		t.Fatalf("slotHandler fairQueue releaseFunc not aligned: %q", fairQueue.RPC.ReleaseFunc)
	}
	if fairQueue.UtilWindowSec != 10 {
		t.Fatalf("slotHandler fairQueue utilWindowSec not aligned: %d", fairQueue.UtilWindowSec)
	}
	if fairQueue.MaxBatch != 8 {
		t.Fatalf("slotHandler fairQueue maxBatch not aligned: %d", fairQueue.MaxBatch)
	}
	if fairQueue.MaxProbeParallel != 4 {
		t.Fatalf("slotHandler fairQueue maxProbeParallel not aligned: %d", fairQueue.MaxProbeParallel)
	}
	if fairQueue.MaxProbeQpsPerHost != 20 {
		t.Fatalf("slotHandler fairQueue maxProbeQpsPerHost not aligned: %d", fairQueue.MaxProbeQpsPerHost)
	}
	assertIntPtrEq("globalMaxInFlightFlow", fairQueue.GlobalMaxInFlightFlow, 300)
	assertIntPtrEq("hostMaxInFlightFlow", fairQueue.HostMaxInFlightFlow, 100)
	assertIntPtrEq("siteMaxInFlightFlow", fairQueue.SiteMaxInFlightFlow, 50)
	assertIntPtrEq("ipBucketMaxInFlightFlow", fairQueue.IPBucketMaxInFlightFlow, 10)
	if staging.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("download fairQueue slotHandlerAuthHeader not aligned: %q", staging.Download.FairQueue.SlotHandlerAuthHeader)
	}
	if staging.Download.FairQueue.SlotHandlerAuthHeader != staging.SlotHandler.Auth.Header {
		t.Fatalf("download fairQueue slotHandlerAuthHeader must match slotHandler auth header")
	}

	stagingThrottle, ok := staging.Download.ThrottleProfiles["default"]
	if !ok {
		t.Fatalf("staging download default throttle profile missing")
	}
	if stagingThrottle.OpenCapSeconds != 60 || stagingThrottle.OpenThresholdPercent != 30 || stagingThrottle.EwmaSpan != 8 {
		t.Fatalf("staging default throttle profile not aligned: %+v", stagingThrottle)
	}
	if stagingThrottle.ConsecutiveThreshold != 4 {
		t.Fatalf("staging throttle consecutiveThreshold not aligned: %d", stagingThrottle.ConsecutiveThreshold)
	}
	if stagingThrottle.MinSamplesBeforeEwmaOpen != 8 {
		t.Fatalf("staging throttle minSamplesBeforeEwmaOpen not aligned: %d", stagingThrottle.MinSamplesBeforeEwmaOpen)
	}
	if stagingThrottle.IdleResetSeconds != 900 {
		t.Fatalf("staging throttle idleResetSeconds not aligned: %d", stagingThrottle.IdleResetSeconds)
	}
	if stagingThrottle.CloseThresholdPercent != 15 {
		t.Fatalf("staging throttle closeThresholdPercent not aligned: %d", stagingThrottle.CloseThresholdPercent)
	}
	if stagingThrottle.HalfOpenSuccessThreshold != 2 {
		t.Fatalf("staging throttle halfOpenSuccessThreshold not aligned: %d", stagingThrottle.HalfOpenSuccessThreshold)
	}
	if stagingThrottle.HalfOpenCloseMode != "and" {
		t.Fatalf("staging throttle halfOpenCloseMode not aligned: %q", stagingThrottle.HalfOpenCloseMode)
	}
	if stagingThrottle.HalfOpenMaxProbeCount != 4 {
		t.Fatalf("staging throttle halfOpenMaxProbeCount not aligned: %d", stagingThrottle.HalfOpenMaxProbeCount)
	}
	if stagingThrottle.HalfOpenMaxSeconds != 15 {
		t.Fatalf("staging throttle halfOpenMaxSeconds not aligned: %d", stagingThrottle.HalfOpenMaxSeconds)
	}
	if stagingThrottle.HalfOpenTimeoutMode != "partial-close" {
		t.Fatalf("staging throttle halfOpenTimeoutMode not aligned: %q", stagingThrottle.HalfOpenTimeoutMode)
	}
	if len(stagingThrottle.ProtectHTTPCodes) != 6 {
		t.Fatalf("staging throttle protectHttpCodes not aligned: %+v", stagingThrottle.ProtectHTTPCodes)
	}

	prod, ok := cfg.Envs["prod"]
	if !ok {
		t.Fatalf("prod env missing in config.yaml")
	}
	if prod.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("prod download fairQueue slotHandlerAuthHeader not aligned: %q", prod.Download.FairQueue.SlotHandlerAuthHeader)
	}
	if prod.Download.FairQueue.SlotHandlerAuthHeader != prod.SlotHandler.Auth.Header {
		t.Fatalf("prod download fairQueue slotHandlerAuthHeader must match slotHandler auth header")
	}
	if prod.SlotHandler.FairQueue.RPC.TryAcquireFunc != "fq_admit_batch" {
		t.Fatalf("prod slotHandler fairQueue tryAcquireFunc not aligned: %q", prod.SlotHandler.FairQueue.RPC.TryAcquireFunc)
	}
	if prod.SlotHandler.FairQueue.RPC.ReleaseFunc != "fq_release_dual" {
		t.Fatalf("prod slotHandler fairQueue releaseFunc not aligned: %q", prod.SlotHandler.FairQueue.RPC.ReleaseFunc)
	}
	prodThrottle, ok := prod.Download.ThrottleProfiles["default"]
	if !ok {
		t.Fatalf("prod download default throttle profile missing")
	}
	if prodThrottle.OpenCapSeconds != 60 || prodThrottle.OpenThresholdPercent != 30 || prodThrottle.EwmaSpan != 8 {
		t.Fatalf("prod default throttle profile not aligned: %+v", prodThrottle)
	}
	if prodThrottle.ConsecutiveThreshold != 4 {
		t.Fatalf("prod throttle consecutiveThreshold not aligned: %d", prodThrottle.ConsecutiveThreshold)
	}
	if prodThrottle.MinSamplesBeforeEwmaOpen != 8 {
		t.Fatalf("prod throttle minSamplesBeforeEwmaOpen not aligned: %d", prodThrottle.MinSamplesBeforeEwmaOpen)
	}
	if prodThrottle.IdleResetSeconds != 900 {
		t.Fatalf("prod throttle idleResetSeconds not aligned: %d", prodThrottle.IdleResetSeconds)
	}
	if prodThrottle.CloseThresholdPercent != 15 {
		t.Fatalf("prod throttle closeThresholdPercent not aligned: %d", prodThrottle.CloseThresholdPercent)
	}
	if prodThrottle.HalfOpenSuccessThreshold != 2 {
		t.Fatalf("prod throttle halfOpenSuccessThreshold not aligned: %d", prodThrottle.HalfOpenSuccessThreshold)
	}
	if prodThrottle.HalfOpenCloseMode != "and" {
		t.Fatalf("prod throttle halfOpenCloseMode not aligned: %q", prodThrottle.HalfOpenCloseMode)
	}
	if prodThrottle.HalfOpenMaxProbeCount != 4 {
		t.Fatalf("prod throttle halfOpenMaxProbeCount not aligned: %d", prodThrottle.HalfOpenMaxProbeCount)
	}
	if prodThrottle.HalfOpenMaxSeconds != 15 {
		t.Fatalf("prod throttle halfOpenMaxSeconds not aligned: %d", prodThrottle.HalfOpenMaxSeconds)
	}
	if prodThrottle.HalfOpenTimeoutMode != "partial-close" {
		t.Fatalf("prod throttle halfOpenTimeoutMode not aligned: %q", prodThrottle.HalfOpenTimeoutMode)
	}
	if len(prodThrottle.ProtectHTTPCodes) != 6 {
		t.Fatalf("prod throttle protectHttpCodes not aligned: %+v", prodThrottle.ProtectHTTPCodes)
	}
}

func TestSampleConfigUsesTicketStateTableKeys(t *testing.T) {
	text := sampleConfigText(t)
	if !strings.Contains(text, "ticketStateTable:") {
		t.Fatalf("config.yaml must declare ticketStateTable keys")
	}
	if strings.Contains(text, "idleTable:") {
		t.Fatalf("config.yaml must not keep landing idleTable keys once ticket contract is enabled")
	}
	if strings.Contains(text, "lastActiveTable:") {
		t.Fatalf("config.yaml must not keep download lastActiveTable keys once ticket contract is enabled")
	}
}

func TestLoadAllowsCaseInsensitiveSlotHandlerAuthHeaderMatch(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config.yaml: %v", err)
	}

	original := string(data)
	mutated := strings.Replace(original, `slotHandlerAuthHeader: "X-FQ-Auth"`, `slotHandlerAuthHeader: "x-fq-auth"`, 1)
	if mutated == original {
		t.Fatalf("failed to mutate slotHandlerAuthHeader casing in config.yaml")
	}

	tmpPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(tmpPath, []byte(mutated), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}

	cfg, err := Load(tmpPath)
	if err != nil {
		t.Fatalf("expected case-insensitive slot-handler auth header match, got %v", err)
	}

	staging, ok := cfg.Envs["staging"]
	if !ok {
		t.Fatalf("staging env missing in config.yaml")
	}
	if staging.Download.FairQueue.SlotHandlerAuthHeader != "X-FQ-Auth" {
		t.Fatalf("expected normalized download fairQueue auth header, got %q", staging.Download.FairQueue.SlotHandlerAuthHeader)
	}
	if staging.SlotHandler.Auth.Header != "X-FQ-Auth" {
		t.Fatalf("expected normalized slotHandler auth header, got %q", staging.SlotHandler.Auth.Header)
	}
}

func TestSampleConfigUsesMinimalThrottleProfileSchema(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config.yaml: %v", err)
	}

	text := string(data)
	lines := strings.Split(text, "\n")
	blocks := make([]string, 0, 2)
	inBlock := false
	blockIndent := 0
	blockStart := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if !inBlock && trimmed == "throttleProfiles:" {
			inBlock = true
			blockIndent = indent
			blockStart = i
			continue
		}
		if inBlock && trimmed != "" && indent <= blockIndent {
			blocks = append(blocks, strings.Join(lines[blockStart:i], "\n"))
			inBlock = false
		}
	}
	if inBlock {
		blocks = append(blocks, strings.Join(lines[blockStart:], "\n"))
	}
	if len(blocks) == 0 {
		t.Fatalf("config.yaml missing throttleProfiles blocks")
	}
	throttleText := strings.Join(blocks, "\n")

	for _, legacy := range []string{
		"observeWindowSeconds:",
		"errorRatioPercent:",
		"minSampleCount:",
		"fastErrorRatioPercent:",
		"fastMinSampleCount:",
		"cleanupPercentage:",
		"tableName:",
	} {
		if strings.Contains(throttleText, legacy) {
			t.Fatalf("legacy throttle field still documented in config.yaml: %s", legacy)
		}
	}
	for _, want := range []string{
		"openCapSeconds:",
		"openThresholdPercent:",
		"closeThresholdPercent:",
		"ewmaSpan:",
		"consecutiveThreshold:",
		"minSamplesBeforeEwmaOpen:",
		"idleResetSeconds:",
		"halfOpenSuccessThreshold:",
		"halfOpenCloseMode:",
		"halfOpenMaxProbeCount:",
		"halfOpenMaxSeconds:",
		"halfOpenTimeoutMode:",
		"protectHttpCodes:",
	} {
		if !strings.Contains(throttleText, want) {
			t.Fatalf("config.yaml missing throttle field %s", want)
		}
	}
}

func TestSampleConfigDocumentsExplicitDownloadAdmissionBlocksPerEnv(t *testing.T) {
	text := sampleConfigText(t)

	stagingStart := envSectionStart(text, "staging")
	prodStart := envSectionStart(text, "prod")
	if stagingStart < 0 || prodStart < 0 || prodStart <= stagingStart {
		t.Fatalf("config.yaml missing staging/prod env sections")
	}

	for env, block := range map[string]string{
		"staging": text[stagingStart:prodStart],
		"prod":    text[prodStart:],
	} {
		fqBlock := extractFairQueueBlock(block)
		if fqBlock == "" {
			t.Fatalf("config.yaml %s missing fairQueue block", env)
		}
		for _, want := range []string{
			"enabled:",
			"hostPatterns:",
			"slotHandlerUrl:",
			"slotHandlerAuthKey:",
			"slotHandlerAuthHeader:",
			"siteBucket:",
			"mode:",
			"modes:",
		} {
			if !strings.Contains(fqBlock, want) {
				t.Fatalf("config.yaml %s fairQueue block missing %s", env, want)
			}
		}

		tcBlock := extractTrueConcurrencyBlock(block)
		if tcBlock == "" {
			t.Fatalf("config.yaml %s missing trueConcurrency block", env)
		}
		for _, want := range []string{
			"enabled:",
			"hostPatterns:",
			"handlerUrl:",
			"handlerAuthKey:",
			"handlerAuthHeader:",
			"siteBucket:",
			"mode:",
			"modes:",
			"acquireTimeoutMs:",
			"releaseTimeoutMs:",
		} {
			if !strings.Contains(tcBlock, want) {
				t.Fatalf("config.yaml %s trueConcurrency block missing %s", env, want)
			}
		}
	}
}

func TestSampleConfigAlignsTrueConcurrencyContract(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	cfgPath := filepath.Join(filepath.Dir(file), "..", "..", "config.yaml")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load(%s) failed: %v", cfgPath, err)
	}

	staging := cfg.Envs["staging"]
	if !staging.Download.TrueConcurrency.Enabled {
		t.Fatalf("staging trueConcurrency must be enabled")
	}
	if !reflect.DeepEqual(staging.Download.TrueConcurrency.HostPatterns, []string{"*.sharepoint.com"}) {
		t.Fatalf("staging trueConcurrency hostPatterns not aligned: %+v", staging.Download.TrueConcurrency.HostPatterns)
	}
	if staging.Download.TrueConcurrency.HandlerURL != "https://concurrency-handler-staging.example.com" {
		t.Fatalf("staging trueConcurrency handlerUrl not aligned: %q", staging.Download.TrueConcurrency.HandlerURL)
	}
	if staging.Download.TrueConcurrency.HandlerAuthKey != "replace-with-concurrency-handler-key" {
		t.Fatalf("staging trueConcurrency handlerAuthKey not aligned: %q", staging.Download.TrueConcurrency.HandlerAuthKey)
	}
	if staging.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
		t.Fatalf("staging trueConcurrency handlerAuthHeader not aligned: %q", staging.Download.TrueConcurrency.HandlerAuthHeader)
	}
	if staging.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("staging trueConcurrency siteBucket.mode not aligned: %q", staging.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(staging.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("staging trueConcurrency siteBucket.modes not aligned: %+v", staging.Download.TrueConcurrency.SiteBucket.Modes)
	}
	if staging.Download.TrueConcurrency.AcquireTimeoutMs != 11500 {
		t.Fatalf("staging trueConcurrency acquireTimeoutMs not aligned: %d", staging.Download.TrueConcurrency.AcquireTimeoutMs)
	}
	if staging.Download.TrueConcurrency.ReleaseTimeoutMs != 1500 {
		t.Fatalf("staging trueConcurrency releaseTimeoutMs not aligned: %d", staging.Download.TrueConcurrency.ReleaseTimeoutMs)
	}

	prod := cfg.Envs["prod"]
	if !prod.Download.TrueConcurrency.Enabled {
		t.Fatalf("prod trueConcurrency must be enabled")
	}
	if !reflect.DeepEqual(prod.Download.TrueConcurrency.HostPatterns, []string{"*.sharepoint.com"}) {
		t.Fatalf("prod trueConcurrency hostPatterns not aligned: %+v", prod.Download.TrueConcurrency.HostPatterns)
	}
	if prod.Download.TrueConcurrency.HandlerURL != "https://concurrency-handler.example.com" {
		t.Fatalf("prod trueConcurrency handlerUrl not aligned: %q", prod.Download.TrueConcurrency.HandlerURL)
	}
	if prod.Download.TrueConcurrency.HandlerAuthKey != "replace-with-concurrency-handler-key" {
		t.Fatalf("prod trueConcurrency handlerAuthKey not aligned: %q", prod.Download.TrueConcurrency.HandlerAuthKey)
	}
	if prod.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
		t.Fatalf("prod trueConcurrency handlerAuthHeader not aligned: %q", prod.Download.TrueConcurrency.HandlerAuthHeader)
	}
	if prod.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("prod trueConcurrency siteBucket.mode not aligned: %q", prod.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(prod.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("prod trueConcurrency siteBucket.modes not aligned: %+v", prod.Download.TrueConcurrency.SiteBucket.Modes)
	}
	if prod.Download.TrueConcurrency.AcquireTimeoutMs != 11500 {
		t.Fatalf("prod trueConcurrency acquireTimeoutMs not aligned: %d", prod.Download.TrueConcurrency.AcquireTimeoutMs)
	}
	if prod.Download.TrueConcurrency.ReleaseTimeoutMs != 1500 {
		t.Fatalf("prod trueConcurrency releaseTimeoutMs not aligned: %d", prod.Download.TrueConcurrency.ReleaseTimeoutMs)
	}
}

func TestLoadNormalizesSiteBucketModesForTrueConcurrencyAndFairQueue(t *testing.T) {
	base := sampleConfigText(t)

	t.Run("host mode is accepted for both trueConcurrency and fairQueue", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"host\"\n")
		text = replaceFirstTrueConcurrencyBlock(text, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"host\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"host",
			[]string{"host"},
		)
		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"host",
			[]string{"host"},
		)
	})

	t.Run("host modes list is authoritative for both trueConcurrency and fairQueue", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"sharepoint\"\n          modes:\n            - \" host \"\n            - \"host\"\n            - \"   \"\n")
		text = replaceFirstTrueConcurrencyBlock(text, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n          modes:\n            - \" host \"\n            - \"host\"\n            - \"   \"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"host",
			[]string{"host"},
		)
		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"host",
			[]string{"host"},
		)
	})

	t.Run("trueConcurrency legacy googledrive mode", func(t *testing.T) {
		text := replaceFirstTrueConcurrencyBlock(base, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"googledrive\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"googledrive",
			[]string{"googledrive"},
		)
	})

	t.Run("fairQueue legacy googledrive mode", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"googledrive\"\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"googledrive",
			[]string{"googledrive"},
		)
	})

	t.Run("trueConcurrency modes list is authoritative", func(t *testing.T) {
		text := replaceFirstTrueConcurrencyBlock(base, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"googledrive\"\n          modes:\n            - \" SharePoint \"\n            - \"googledrive\"\n            - \"sharepoint\"\n            - \"   \"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"sharepoint",
			[]string{"sharepoint", "googledrive"},
		)
	})

	t.Run("fairQueue modes list is authoritative", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"googledrive\"\n          modes:\n            - \" SharePoint \"\n            - \"googledrive\"\n            - \"sharepoint\"\n            - \"   \"\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"sharepoint",
			[]string{"sharepoint", "googledrive"},
		)
	})

	t.Run("modes preserve first occurrence order for both surfaces", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"sharepoint\"\n          modes:\n            - \" googledrive \"\n            - \"sharepoint\"\n            - \"googledrive\"\n")
		text = replaceFirstTrueConcurrencyBlock(text, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n          modes:\n            - \" googledrive \"\n            - \"sharepoint\"\n            - \"googledrive\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"googledrive",
			[]string{"googledrive", "sharepoint"},
		)
		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"googledrive",
			[]string{"googledrive", "sharepoint"},
		)
	})
}

func TestLoadDefaultsSiteBucketModesForTrueConcurrencyAndFairQueue(t *testing.T) {
	base := sampleConfigText(t)

	t.Run("trueConcurrency empty siteBucket defaults to sharepoint mode set", func(t *testing.T) {
		text := replaceFirstTrueConcurrencyBlock(base, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket: {}\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Mode,
			cfg.Envs["staging"].Download.TrueConcurrency.SiteBucket.Modes,
			"sharepoint",
			[]string{"sharepoint"},
		)
	})

	t.Run("fairQueue empty siteBucket defaults to sharepoint mode set", func(t *testing.T) {
		text := replaceFirstFairQueueBlock(base, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket: {}\n")

		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}

		assertSiteBucketNormalized(t,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Mode,
			cfg.Envs["staging"].Download.FairQueue.SiteBucket.Modes,
			"sharepoint",
			[]string{"sharepoint"},
		)
	})
}

func TestLoadRejectsInvalidSiteBucketModesForTrueConcurrencyAndFairQueue(t *testing.T) {
	base := sampleConfigText(t)
	for _, tc := range []struct {
		name    string
		mutate  func(string) string
		wantErr string
	}{
		{
			name: "invalid trueConcurrency mode",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"google\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.siteBucket",
		},
		{
			name: "invalid fairQueue mode",
			mutate: func(src string) string {
				return replaceFirstFairQueueBlock(src, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          mode: \"google\"\n")
			},
			wantErr: "download.fairQueue.siteBucket",
		},
		{
			name: "invalid trueConcurrency modes entry",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          modes:\n            - \"sharepoint\"\n            - \"google\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.siteBucket",
		},
		{
			name: "invalid fairQueue modes entry",
			mutate: func(src string) string {
				return replaceFirstFairQueueBlock(src, "      fairQueue:\n        enabled: true\n        backend: \"slot-handler\"\n        hostPatterns: [\"*.sharepoint.com\"]\n        slotHandlerUrl: \"https://slot-handler-staging.example.com\"\n        slotHandlerAuthKey: \"replace-with-slot-handler-key\"\n        slotHandlerAuthHeader: \"X-FQ-Auth\"\n        slotHandlerTimeoutMs: 20000\n        perRequestTimeoutMs: 8000\n        maxAttemptsCap: 35\n        siteBucket:\n          modes:\n            - \"sharepoint\"\n            - \"google\"\n")
			},
			wantErr: "download.fairQueue.siteBucket",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadConfigFromText(t, tc.mutate(base))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestLoadRejectsInvalidTrueConcurrencyConfig(t *testing.T) {
	base := sampleConfigText(t)
	for _, tc := range []struct {
		name    string
		mutate  func(string) string
		wantErr string
	}{
		{
			name: "missing host patterns when enabled",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns: []\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.hostPatterns",
		},
		{
			name: "whitespace-only handlerUrl when enabled",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"   \"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.handlerUrl",
		},
		{
			name: "whitespace-only handlerAuthKey when enabled",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"   \"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.handlerAuthKey",
		},
		{
			name: "invalid site bucket mode",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"google\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.siteBucket.mode",
		},
		{
			name: "explicit zero acquire timeout",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 0\n        releaseTimeoutMs: 1500\n")
			},
			wantErr: "download.trueConcurrency.acquireTimeoutMs",
		},
		{
			name: "negative release timeout",
			mutate: func(src string) string {
				return replaceFirstTrueConcurrencyBlock(src, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: -1\n")
			},
			wantErr: "download.trueConcurrency.releaseTimeoutMs",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadConfigFromText(t, tc.mutate(base))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestLoadNormalizesTrueConcurrencyFieldsAndAppliesDefaultsWhenTimeoutsAreOmitted(t *testing.T) {
	text := replaceFirstTrueConcurrencyBlock(sampleConfigText(t), "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"  *.sharepoint.com  \"\n          - \"   \"\n        handlerUrl: \" https://concurrency-handler-staging.example.com \"\n        handlerAuthKey: \" replace-with-concurrency-handler-key \"\n        handlerAuthHeader: \" x-cq-auth \"\n        siteBucket:\n          mode: \" SharePoint \"\n")

	cfg, err := loadConfigFromText(t, text)
	if err != nil {
		t.Fatalf("Load(temp config) failed: %v", err)
	}

	staging := cfg.Envs["staging"]
	if !reflect.DeepEqual(staging.Download.TrueConcurrency.HostPatterns, []string{"*.sharepoint.com"}) {
		t.Fatalf("expected trimmed trueConcurrency hostPatterns, got %+v", staging.Download.TrueConcurrency.HostPatterns)
	}
	if staging.Download.TrueConcurrency.HandlerURL != "https://concurrency-handler-staging.example.com" {
		t.Fatalf("expected normalized trueConcurrency handlerUrl, got %q", staging.Download.TrueConcurrency.HandlerURL)
	}
	if staging.Download.TrueConcurrency.HandlerAuthKey != "replace-with-concurrency-handler-key" {
		t.Fatalf("expected normalized trueConcurrency handlerAuthKey, got %q", staging.Download.TrueConcurrency.HandlerAuthKey)
	}
	if staging.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
		t.Fatalf("expected normalized trueConcurrency auth header, got %q", staging.Download.TrueConcurrency.HandlerAuthHeader)
	}
	if staging.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
		t.Fatalf("expected normalized siteBucket.mode, got %q", staging.Download.TrueConcurrency.SiteBucket.Mode)
	}
	if !reflect.DeepEqual(staging.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
		t.Fatalf("expected normalized siteBucket.modes, got %+v", staging.Download.TrueConcurrency.SiteBucket.Modes)
	}
	if staging.Download.TrueConcurrency.AcquireTimeoutMs != 11500 {
		t.Fatalf("expected default acquireTimeoutMs, got %d", staging.Download.TrueConcurrency.AcquireTimeoutMs)
	}
	if staging.Download.TrueConcurrency.ReleaseTimeoutMs != 1500 {
		t.Fatalf("expected default releaseTimeoutMs, got %d", staging.Download.TrueConcurrency.ReleaseTimeoutMs)
	}
}

func TestLoadDefaultsTrueConcurrencyHeaderAndSiteBucketModeWhenOmittedOrEmpty(t *testing.T) {
	base := sampleConfigText(t)

	t.Run("omitted fields", func(t *testing.T) {
		text := replaceFirstTrueConcurrencyBlock(base, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        siteBucket: {}\n")
		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}
		staging := cfg.Envs["staging"]
		if staging.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
			t.Fatalf("expected default trueConcurrency auth header, got %q", staging.Download.TrueConcurrency.HandlerAuthHeader)
		}
		if staging.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
			t.Fatalf("expected default trueConcurrency siteBucket.mode, got %q", staging.Download.TrueConcurrency.SiteBucket.Mode)
		}
		if !reflect.DeepEqual(staging.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
			t.Fatalf("expected default trueConcurrency siteBucket.modes, got %+v", staging.Download.TrueConcurrency.SiteBucket.Modes)
		}
	})

	t.Run("empty fields", func(t *testing.T) {
		text := replaceFirstTrueConcurrencyBlock(base, "      trueConcurrency:\n        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"   \"\n        siteBucket:\n          mode: \"   \"\n        acquireTimeoutMs: 11500\n        releaseTimeoutMs: 1500\n")
		cfg, err := loadConfigFromText(t, text)
		if err != nil {
			t.Fatalf("Load(temp config) failed: %v", err)
		}
		staging := cfg.Envs["staging"]
		if staging.Download.TrueConcurrency.HandlerAuthHeader != "X-CQ-Auth" {
			t.Fatalf("expected default trueConcurrency auth header from empty input, got %q", staging.Download.TrueConcurrency.HandlerAuthHeader)
		}
		if staging.Download.TrueConcurrency.SiteBucket.Mode != "sharepoint" {
			t.Fatalf("expected default trueConcurrency siteBucket.mode from empty input, got %q", staging.Download.TrueConcurrency.SiteBucket.Mode)
		}
		if !reflect.DeepEqual(staging.Download.TrueConcurrency.SiteBucket.Modes, []string{"sharepoint"}) {
			t.Fatalf("expected default trueConcurrency siteBucket.modes from empty input, got %+v", staging.Download.TrueConcurrency.SiteBucket.Modes)
		}
	})
}

func TestLoadPreservesMergedTrueConcurrencyExplicitTimeouts(t *testing.T) {
	text := replaceFirstTrueConcurrencyBlockWithMergeTemplate(sampleConfigText(t), "tcbase", "        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 9999\n        releaseTimeoutMs: 2222\n")

	cfg, err := loadConfigFromText(t, text)
	if err != nil {
		t.Fatalf("Load(temp config) failed: %v", err)
	}

	staging := cfg.Envs["staging"]
	if staging.Download.TrueConcurrency.AcquireTimeoutMs != 9999 {
		t.Fatalf("expected merged acquireTimeoutMs to survive load, got %d", staging.Download.TrueConcurrency.AcquireTimeoutMs)
	}
	if staging.Download.TrueConcurrency.ReleaseTimeoutMs != 2222 {
		t.Fatalf("expected merged releaseTimeoutMs to survive load, got %d", staging.Download.TrueConcurrency.ReleaseTimeoutMs)
	}
}

func TestLoadRejectsInvalidMergedTrueConcurrencyTimeouts(t *testing.T) {
	base := sampleConfigText(t)
	for _, tc := range []struct {
		name         string
		templateBody string
		wantErr      string
	}{
		{
			name:         "merged zero acquire timeout",
			templateBody: "        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 0\n        releaseTimeoutMs: 2222\n",
			wantErr:      "download.trueConcurrency.acquireTimeoutMs",
		},
		{
			name:         "merged negative release timeout",
			templateBody: "        enabled: true\n        hostPatterns:\n          - \"*.sharepoint.com\"\n        handlerUrl: \"https://concurrency-handler-staging.example.com\"\n        handlerAuthKey: \"replace-with-concurrency-handler-key\"\n        handlerAuthHeader: \"X-CQ-Auth\"\n        siteBucket:\n          mode: \"sharepoint\"\n        acquireTimeoutMs: 9999\n        releaseTimeoutMs: -1\n",
			wantErr:      "download.trueConcurrency.releaseTimeoutMs",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := replaceFirstTrueConcurrencyBlockWithMergeTemplate(base, "tcbase", tc.templateBody)
			_, err := loadConfigFromText(t, text)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestSlotHandlerFairQueueDefaultsUseAtomicAdmitRPC(t *testing.T) {
	var cfg SlotHandlerFairQueueConfig

	if err := cfg.ensureDefaults(); err != nil {
		t.Fatalf("ensureDefaults() failed: %v", err)
	}

	if cfg.RPC.TryAcquireFunc != "fq_admit_batch" {
		t.Fatalf("expected default tryAcquireFunc fq_admit_batch, got %q", cfg.RPC.TryAcquireFunc)
	}
	if cfg.RPC.ReleaseFunc != "fq_release_dual" {
		t.Fatalf("expected default releaseFunc fq_release_dual, got %q", cfg.RPC.ReleaseFunc)
	}
}
