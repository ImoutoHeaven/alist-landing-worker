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
}
