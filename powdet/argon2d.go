package main

import _ "unsafe"

// argon2d mode constant from golang.org/x/crypto/argon2.
const argon2dMode = 0

//go:linkname argon2DeriveKey golang.org/x/crypto/argon2.deriveKey
func argon2DeriveKey(mode int, password, salt, secret, data []byte, time, memory uint32, threads uint8, keyLen uint32) []byte

func argon2dKey(password, salt []byte, time, memory uint32, threads uint8, keyLen uint32) []byte {
	return argon2DeriveKey(argon2dMode, password, salt, nil, nil, time, memory, threads, keyLen)
}
