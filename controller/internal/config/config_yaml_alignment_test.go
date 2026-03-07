package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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
	if stagingThrottle.OpenCapSeconds != 60 || stagingThrottle.OpenThresholdPercent != 20 || stagingThrottle.EwmaSpan != 8 {
		t.Fatalf("staging default throttle profile not aligned: %+v", stagingThrottle)
	}
	if stagingThrottle.ConsecutiveThreshold != 4 {
		t.Fatalf("staging throttle consecutiveThreshold not aligned: %d", stagingThrottle.ConsecutiveThreshold)
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
	prodThrottle, ok := prod.Download.ThrottleProfiles["default"]
	if !ok {
		t.Fatalf("prod download default throttle profile missing")
	}
	if prodThrottle.OpenCapSeconds != 60 || prodThrottle.OpenThresholdPercent != 20 || prodThrottle.EwmaSpan != 8 {
		t.Fatalf("prod default throttle profile not aligned: %+v", prodThrottle)
	}
	if prodThrottle.ConsecutiveThreshold != 4 {
		t.Fatalf("prod throttle consecutiveThreshold not aligned: %d", prodThrottle.ConsecutiveThreshold)
	}
	if len(prodThrottle.ProtectHTTPCodes) != 6 {
		t.Fatalf("prod throttle protectHttpCodes not aligned: %+v", prodThrottle.ProtectHTTPCodes)
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
		"ewmaSpan:",
		"consecutiveThreshold:",
		"protectHttpCodes:",
	} {
		if !strings.Contains(throttleText, want) {
			t.Fatalf("config.yaml missing throttle field %s", want)
		}
	}
}
