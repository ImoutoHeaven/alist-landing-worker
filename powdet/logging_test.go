package main

import (
	"strings"
	"testing"
)

func TestPowdetSanitizeLogValueRedactsSensitiveInputs(t *testing.T) {
	got := sanitizeLogValue("token=secret challenge=abcdef nonce=1234 preimage=deadbeef Authorization: Bearer leaked")

	assertNotContains(t, got, "secret")
	assertNotContains(t, got, "abcdef")
	assertNotContains(t, got, "1234")
	assertNotContains(t, got, "deadbeef")
	assertNotContains(t, got, "Bearer leaked")
	assertContains(t, got, "[redacted]")
}

func TestPowdetLogLineUsesComponentPrefix(t *testing.T) {
	got := formatLogLine("warn", "verify_failed", map[string]any{
		"alg":   "argon2id",
		"token": "secret",
	})

	assertContains(t, got, "[Powdet] verify_failed")
	assertContains(t, got, "alg=argon2id")
	assertNotContains(t, got, "secret")
}

func TestPowdetSanitizeLogValueRedactsJSONStyleSensitiveErrorText(t *testing.T) {
	got := sanitizeLogValue(`controller bootstrap failed: status=502 body={"adminApiToken":"super-secret","challenge":"abcdef","nonce":"1234","preimage":"deadbeef","token":"leaked","status":403,"alg":"argon2id"}`)

	assertContains(t, got, "status=502")
	assertContains(t, got, `"status":403`)
	assertContains(t, got, `"alg":"argon2id"`)
	assertContains(t, got, "[redacted]")
	assertNotContains(t, got, "super-secret")
	assertNotContains(t, got, "abcdef")
	assertNotContains(t, got, "1234")
	assertNotContains(t, got, "deadbeef")
	assertNotContains(t, got, "leaked")
}

func TestPowdetSanitizeLogValueRedactsIPAddressesAndCIDRs(t *testing.T) {
	got := sanitizeLogValue("status=403 ip=203.0.113.9 clientIp=2001:db8::1 loopback=::1 cidr=10.0.0.0/24 ipv6Cidr=2001:db8:abcd::/48 loopbackCidr=::1/128 alg=argon2id")

	assertContains(t, got, "status=403")
	assertContains(t, got, "alg=argon2id")
	assertContains(t, got, "[redacted]")
	assertNotContains(t, got, "203.0.113.9")
	assertNotContains(t, got, "2001:db8::1")
	assertNotContains(t, got, "::1")
	assertNotContains(t, got, "10.0.0.0/24")
	assertNotContains(t, got, "2001:db8:abcd::/48")
	assertNotContains(t, got, "::1/128")
}

func TestPowdetLogLineRedactsIPAndCIDRFields(t *testing.T) {
	got := formatLogLine("warn", "verify_failed", map[string]any{
		"alg":          "argon2id",
		"clientIp":     "203.0.113.9",
		"cidr":         "2001:db8:abcd::/48",
		"loopback":     "::1",
		"loopbackCidr": "::1/128",
		"status":       403,
	})

	assertContains(t, got, "[Powdet] verify_failed")
	assertContains(t, got, "alg=argon2id")
	assertContains(t, got, "status=403")
	assertContains(t, got, "[redacted]")
	assertNotContains(t, got, "203.0.113.9")
	assertNotContains(t, got, "2001:db8:abcd::/48")
	assertNotContains(t, got, "::1")
	assertNotContains(t, got, "::1/128")
}

func TestPowdetLogLineRedactsControllerErrorBodyInReason(t *testing.T) {
	got := formatLogLine("warn", "flush_failed", map[string]any{
		"action": "send_snapshot",
		"reason": `controller metrics failed: status=502 body={"token":"metric-token","challenge":"payload","nonce":"cafebabe","preimage":"feedface","alg":"argon2id"}`,
	})

	assertContains(t, got, "[Powdet] flush_failed")
	assertContains(t, got, "action=send_snapshot")
	assertContains(t, got, "status=502")
	assertContains(t, got, `"alg":"argon2id"`)
	assertContains(t, got, "[redacted]")
	assertNotContains(t, got, "metric-token")
	assertNotContains(t, got, "payload")
	assertNotContains(t, got, "cafebabe")
	assertNotContains(t, got, "feedface")
}

func assertContains(t *testing.T, got string, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Fatalf("expected %q to contain %q", got, want)
	}
}

func assertNotContains(t *testing.T, got string, forbidden string) {
	t.Helper()
	if strings.Contains(got, forbidden) {
		t.Fatalf("expected %q not to contain %q", got, forbidden)
	}
}
