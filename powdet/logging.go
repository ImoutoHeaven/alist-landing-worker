package main

import (
	"fmt"
	"log"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
)

var sensitiveLogKeyPattern = regexp.MustCompile(`(?i)(authorization|bearer|token|secret|challenge|nonce|preimage|payload|seed|api[_-]?token)`)
var authorizationLogPattern = regexp.MustCompile(`(?i)Authorization:\s*Bearer\s+\S+|Bearer\s+\S+`)
var sensitivePairLogPattern = regexp.MustCompile(`(?i)\b(authorization|token|secret|challenge|nonce|preimage|payload|seed|api[_-]?token)=([^\s,}\]]+)`)
var sensitiveJSONLogPattern = regexp.MustCompile(`(?i)("(?:authorization|token|secret|challenge|nonce|preimage|payload|seed|api[_-]?token|adminApiToken)"\s*:\s*)"(?:\\.|[^"\\])*"`)
var ipv4LogPattern = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:/(?:3[0-2]|[12]?\d))?\b`)
var leadingCompressedIPv6LogPattern = regexp.MustCompile(`(?i)(^|[^0-9a-f:])(::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4}(?:/(?:12[0-8]|1[01]\d|[1-9]?\d))?)\b`)
var ipv6CIDRLogPattern = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*/(?:12[0-8]|1[01]\d|[1-9]?\d)\b`)
var ipv6LogPattern = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*[0-9a-f]\b`)

func sanitizeLogValue(value any) string {
	text := fmt.Sprint(value)
	text = strings.ReplaceAll(text, "\r", " ")
	text = strings.ReplaceAll(text, "\n", " ")
	text = authorizationLogPattern.ReplaceAllString(text, "[redacted]")
	text = sensitivePairLogPattern.ReplaceAllString(text, "$1=[redacted]")
	text = sensitiveJSONLogPattern.ReplaceAllString(text, `$1"[redacted]"`)
	text = redactURLQueries(text)
	text = redactIPAddresses(text)
	return strings.TrimSpace(text)
}

func formatLogLine(level string, event string, fields map[string]any) string {
	parts := []string{"[Powdet]", sanitizeLogValue(event)}

	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		if strings.TrimSpace(key) == "" {
			continue
		}
		value := fields[key]
		if sensitiveLogKeyPattern.MatchString(key) {
			parts = append(parts, fmt.Sprintf("%s=[redacted]", sanitizeLogKey(key)))
			continue
		}
		sanitized := sanitizeLogValue(value)
		if sanitized == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", sanitizeLogKey(key), sanitized))
	}

	return strings.Join(parts, " ")
}

func powdetLog(level string, event string, fields map[string]any) {
	log.Print(formatLogLine(level, event, fields))
}

func powdetFatal(event string, fields map[string]any) {
	powdetLog("fatal", event, fields)
	os.Exit(1)
}

func sanitizeLogKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return "field"
	}
	return regexp.MustCompile(`[^A-Za-z0-9_.-]`).ReplaceAllString(key, "_")
}

func redactURLQueries(text string) string {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return text
	}
	for i, field := range fields {
		trimmed := strings.Trim(field, ",;)]}")
		parsed, err := url.Parse(trimmed)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery == "" {
			continue
		}
		parsed.RawQuery = "[redacted]"
		fields[i] = strings.Replace(field, trimmed, parsed.String(), 1)
	}
	return strings.Join(fields, " ")
}

func redactIPAddresses(text string) string {
	text = ipv4LogPattern.ReplaceAllStringFunc(text, func(candidate string) string {
		if strings.Contains(candidate, "/") {
			if _, err := netip.ParsePrefix(candidate); err == nil {
				return "[redacted]"
			}
			return candidate
		}
		if _, err := netip.ParseAddr(candidate); err == nil {
			return "[redacted]"
		}
		return candidate
	})
	text = ipv6CIDRLogPattern.ReplaceAllStringFunc(text, func(candidate string) string {
		if _, err := netip.ParsePrefix(candidate); err == nil {
			return "[redacted]"
		}
		return candidate
	})
	text = leadingCompressedIPv6LogPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := leadingCompressedIPv6LogPattern.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		candidate := parts[2]
		if strings.Contains(candidate, "/") {
			if _, err := netip.ParsePrefix(candidate); err == nil {
				return parts[1] + "[redacted]"
			}
			return match
		}
		if _, err := netip.ParseAddr(candidate); err == nil {
			return parts[1] + "[redacted]"
		}
		return match
	})
	text = ipv6LogPattern.ReplaceAllStringFunc(text, func(candidate string) string {
		if _, err := netip.ParseAddr(candidate); err == nil {
			return "[redacted]"
		}
		return candidate
	})
	return text
}
