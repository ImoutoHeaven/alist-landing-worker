package policy

import (
	"fmt"
	"strings"

	"controller/internal/config"
)

const (
	defaultDecisionTTL = 60
)

// Engine keeps config and decision logic.
type Engine struct {
	cfg *config.RootConfig
}

// NewEngine constructs a decision engine.
func NewEngine(cfg *config.RootConfig) *Engine {
	return &Engine{cfg: cfg}
}

// EvalDecision is the exposed decision entry; v0 only matches path rules.
func (e *Engine) EvalDecision(ctx DecisionContext) (DecisionResult, error) {
	res := DecisionResult{
		PolicyVersion: e.cfg.RulesVersion,
		TTLSeconds:    defaultDecisionTTL,
		Meta: MetaInfo{
			RuleIds: []string{},
			Tags: []string{
				fmt.Sprintf("env_%s", ctx.Env),
				fmt.Sprintf("role_%s", ctx.Role),
			},
			Explain: []string{},
		},
	}

	switch ctx.Role {
	case "download":
		dl, meta := e.evalDownloadDecision(ctx)
		res.Download = &dl
		res.Meta.RuleIds = append(res.Meta.RuleIds, meta.RuleIds...)
		res.Meta.Explain = append(res.Meta.Explain, meta.Explain...)
	case "landing":
		ld, meta := e.evalLandingDecision(ctx)
		res.Landing = &ld
		res.Meta.RuleIds = append(res.Meta.RuleIds, meta.RuleIds...)
		res.Meta.Explain = append(res.Meta.Explain, meta.Explain...)
	default:
		res.Meta.Explain = append(res.Meta.Explain, "unknown role: "+ctx.Role)
	}

	return res, nil
}

func (e *Engine) evalDownloadDecision(ctx DecisionContext) (DownloadDecision, MetaInfo) {
	envCfg, ok := e.cfg.Envs[ctx.Env]
	if !ok {
		return DownloadDecision{}, MetaInfo{
			RuleIds: nil,
			Explain: []string{"unknown env: " + ctx.Env},
		}
	}

	dlCfg := envCfg.Download
	rules := dlCfg.PathRules

	dd := DownloadDecision{
		PathAction:      []string{},
		CheckOriginMode: dlCfg.OriginBindingDefault,
		// Profile names can line up with controller config keys and be extended later.
		FairQueueProfile: "default",
		ThrottleProfile:  "default",
	}
	meta := MetaInfo{
		RuleIds: []string{},
		Explain: []string{},
	}

	path := ctx.Request.Path

	if rule, ok := matchRuleList(path, rules.Blacklist); ok {
		dd.PathAction = []string{"block"}
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "blacklist "+rule.Name+" matched for path "+path)
		return dd, meta
	}

	if rule, ok := matchRuleList(path, rules.Whitelist); ok {
		dd.PathAction = append(dd.PathAction, rule.Action...)
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "whitelist "+rule.Name+" matched for path "+path)
	}

	if rule, ok := matchRuleList(path, rules.Except); ok {
		dd.PathAction = append(dd.PathAction, rule.Action...)
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "except "+rule.Name+" matched for path "+path)
	}

	return dd, meta
}

func (e *Engine) evalLandingDecision(ctx DecisionContext) (LandingDecision, MetaInfo) {
	envCfg, ok := e.cfg.Envs[ctx.Env]
	if !ok {
		return LandingDecision{
			CaptchaCombo: []string{"verify-altcha"},
			FastRedirect: false,
			AutoRedirect: false,
			BlockReason:  nil,
		}, MetaInfo{
			RuleIds: []string{},
			Explain: []string{"landing: env not found, using default captchaCombo"},
		}
	}

	landingCfg := envCfg.Landing
	path := ctx.Request.Path
	rules := landingCfg.PathRules

	defaultCombo := landingCfg.Captcha.DefaultCombo
	if len(defaultCombo) == 0 {
		defaultCombo = []string{"verify-altcha"}
	}

	ld := LandingDecision{
		CaptchaCombo: append([]string{}, defaultCombo...),
		FastRedirect: landingCfg.FastRedirect,
		AutoRedirect: landingCfg.AutoRedirect,
		BlockReason:  nil,
	}
	meta := MetaInfo{
		RuleIds: []string{},
		Explain: []string{"landing: applied default captchaCombo from config"},
	}

	if rule, ok := matchRuleList(path, rules.Blacklist); ok {
		ld.CaptchaCombo = append([]string{}, rule.Action...)
		if containsAction(rule.Action, "block") {
			reason := "blocked by rule " + rule.Name
			ld.BlockReason = &reason
		}
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "blacklist "+rule.Name+" matched for path "+path)
		return ld, meta
	}

	if rule, ok := matchRuleList(path, rules.Whitelist); ok {
		ld.CaptchaCombo = append([]string{}, rule.Action...)
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "whitelist "+rule.Name+" matched for path "+path)
	}

	if rule, ok := matchRuleList(path, rules.Except); ok {
		ld.CaptchaCombo = append([]string{}, rule.Action...)
		meta.RuleIds = append(meta.RuleIds, rule.Name)
		meta.Explain = append(meta.Explain, "except "+rule.Name+" matched for path "+path)
	}

	if len(ld.CaptchaCombo) == 0 {
		ld.CaptchaCombo = []string{"verify-altcha"}
	}

	return ld, meta
}

func matchRuleList(path string, rules []config.DownloadPathRule) (config.DownloadPathRule, bool) {
	for _, r := range rules {
		if !pathHasPrefix(path, r.Prefix) {
			continue
		}
		if !pathContainsAnyDir(path, r.DirIncludes) {
			continue
		}
		if !pathContainsAnyName(path, r.NameIncludes) {
			continue
		}
		if !pathContainsAny(path, r.PathIncludes) {
			continue
		}
		return r, true
	}
	return config.DownloadPathRule{}, false
}

func containsAction(actions []string, target string) bool {
	if target == "" {
		return false
	}
	for _, action := range actions {
		if strings.EqualFold(action, target) {
			return true
		}
	}
	return false
}

func pathHasPrefix(path string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func pathContainsAny(path string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}
	for _, inc := range includes {
		if strings.Contains(path, inc) {
			return true
		}
	}
	return false
}

func pathContainsAnyDir(path string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}

	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return false
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) <= 1 {
		return false
	}
	dirs := parts[:len(parts)-1]

	for _, dir := range dirs {
		for _, inc := range includes {
			if strings.Contains(dir, inc) {
				return true
			}
		}
	}
	return false
}

func pathContainsAnyName(path string, includes []string) bool {
	if len(includes) == 0 {
		return true
	}

	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return false
	}
	parts := strings.Split(trimmed, "/")
	name := parts[len(parts)-1]

	for _, inc := range includes {
		if strings.Contains(name, inc) {
			return true
		}
	}
	return false
}
