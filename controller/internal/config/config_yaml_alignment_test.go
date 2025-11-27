package config

import (
	"path/filepath"
	"runtime"
	"testing"
)

// ensureSampleConfig decodes with all dynamic fields present (ALTCHA/Powdet).
func TestSampleConfigAlignment(t *testing.T) {
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
	if powdet.StaticLevel == nil {
		t.Fatalf("powdet staticLevel missing")
	}
	if powdet.Dynamic == nil {
		t.Fatalf("powdet dynamic missing")
	}
	if powdet.Dynamic.WindowSeconds == 0 || powdet.Dynamic.ResetSeconds == 0 || powdet.Dynamic.LevelStep == 0 {
		t.Fatalf("powdet dynamic fields incomplete: %+v", powdet.Dynamic)
	}
}
