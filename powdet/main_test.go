package main

import (
	"encoding/base64"
	"encoding/hex"
	"testing"

	randomx "git.gammaspectra.live/P2Pool/go-randomx/v4"
	"golang.org/x/crypto/argon2"
)

func TestNormalizeConfigRandomxDefaults(t *testing.T) {
	cfg := Config{
		Enabled:       true,
		AdminAPIToken: "test-token",
		Algorithms: map[string]PowdetAlgorithmConfig{
			"randomx": {Enabled: true},
		},
	}

	normalized, err := normalizeConfig(cfg)
	if err != nil {
		t.Fatalf("normalizeConfig failed: %v", err)
	}
	algo, ok := normalized.Algorithms[algoRandomx]
	if !ok {
		t.Fatal("randomx config missing after normalization")
	}
	if algo.SeedLen != defaultRandomxSeedLen {
		t.Fatalf("unexpected seedLen: got %d, want %d", algo.SeedLen, defaultRandomxSeedLen)
	}
	if algo.CacheLRUSize != defaultRandomxCacheLRU {
		t.Fatalf("unexpected cacheLRUSize: got %d, want %d", algo.CacheLRUSize, defaultRandomxCacheLRU)
	}
	if algo.CacheTTL != defaultRandomxCacheTTL {
		t.Fatalf("unexpected cacheTTL: got %d, want %d", algo.CacheTTL, defaultRandomxCacheTTL)
	}
}

func TestArgon2HashMeetsDifficulty(t *testing.T) {
	preimage := []byte("preimage")
	nonce := []byte{0x01, 0x23, 0x45, 0x67}
	challenge := Challenge{
		Alg:      algoArgon2id,
		Preimage: base64.StdEncoding.EncodeToString(preimage),
		Argon2Parameters: &Argon2Parameters{
			MemoryKiB:   8,
			Iterations:  1,
			Parallelism: 1,
			KeyLength:   16,
		},
	}

	preimageBytes, err := decodeBase64Fixed(challenge.Preimage, 8)
	if err != nil {
		t.Fatalf("decode preimage failed: %v", err)
	}

	hash := argon2.IDKey(
		nonce,
		preimageBytes,
		uint32(challenge.Argon2Parameters.Iterations),
		uint32(challenge.Argon2Parameters.MemoryKiB),
		uint8(challenge.Argon2Parameters.Parallelism),
		uint32(challenge.Argon2Parameters.KeyLength),
	)
	hashHex := hex.EncodeToString(hash)
	challenge.Difficulty = hashHex[len(hashHex)-2:]

	ok, err := hashMeetsDifficulty(hashHex, challenge.Difficulty)
	if err != nil {
		t.Fatalf("hashMeetsDifficulty returned error: %v", err)
	}
	if !ok {
		t.Fatal("argon2 hash should meet difficulty")
	}
}

func TestRandomxHashMeetsDifficulty(t *testing.T) {
	preimage := []byte("preimage")
	seedKey := []byte("0123456789abcdef0123456789abcdef")
	nonce := []byte{0x10, 0x20, 0x30, 0x40}

	flags := buildRandomxFlags(PowdetAlgorithmConfig{}, false)
	cache, err := randomx.NewCache(flags)
	if err != nil {
		t.Fatalf("randomx cache init failed: %v", err)
	}
	defer func() {
		if err := cache.Close(); err != nil {
			t.Errorf("randomx cache close failed: %v", err)
		}
	}()
	cache.Init(seedKey)

	vm, err := randomx.NewVM(flags, cache, nil)
	if err != nil {
		t.Fatalf("randomx vm init failed: %v", err)
	}
	defer func() {
		if err := vm.Close(); err != nil {
			t.Errorf("randomx vm close failed: %v", err)
		}
	}()

	input := append(append([]byte{}, preimage...), nonce...)
	var output [randomx.RANDOMX_HASH_SIZE]byte
	vm.CalculateHash(input, &output)
	hashHex := hex.EncodeToString(output[:])
	difficulty := hashHex[len(hashHex)-2:]

	ok, err := hashMeetsDifficulty(hashHex, difficulty)
	if err != nil {
		t.Fatalf("hashMeetsDifficulty returned error: %v", err)
	}
	if !ok {
		t.Fatal("randomx hash should meet difficulty")
	}
}
