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

func toString(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case fmt.Stringer:
		return strings.TrimSpace(t.String())
	default:
		return ""
	}
}

func toStringSlice(v any) []string {
	switch val := v.(type) {
	case []string:
		return append([]string{}, val...)
	case []any:
		out := make([]string, 0, len(val))
		for _, item := range val {
			if s := toString(item); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func toIntPointer(v any) *int {
	switch val := v.(type) {
	case int:
		return &val
	case int32:
		tmp := int(val)
		return &tmp
	case int64:
		tmp := int(val)
		return &tmp
	case float64:
		tmp := int(val)
		return &tmp
	case float32:
		tmp := int(val)
		return &tmp
	default:
		return nil
	}
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

	pathGlobal, profiles, _ := config.BuildPathSet(envCfg, "download")
	dlCfg := envCfg.Download

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

	profile := pickProfile(profiles, ctx.ProfileID, pathGlobal.DefaultProfileID)
	if profile != nil {
		dd = applyDownloadActions(*profile, dd)
		meta.RuleIds = append(meta.RuleIds, "profile:"+profile.ID)
		meta.Explain = append(meta.Explain, "applied path profile "+profile.ID)
	} else {
		meta.Explain = append(meta.Explain, "no matching profile, using defaults")
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

	pathGlobal, profiles, _ := config.BuildPathSet(envCfg, "landing")
	profile := pickProfile(profiles, ctx.ProfileID, pathGlobal.DefaultProfileID)
	if profile != nil {
		ld = applyLandingActions(*profile, ld, defaultCombo)
		meta.RuleIds = append(meta.RuleIds, "profile:"+profile.ID)
		meta.Explain = append(meta.Explain, "applied path profile "+profile.ID)
	}

	return ld, meta
}

func pickProfile(profiles []config.PathProfile, profileID string, defaultID string) *config.PathProfile {
	target := strings.TrimSpace(profileID)
	if target == "" {
		target = strings.TrimSpace(defaultID)
	}

	for i := range profiles {
		if profiles[i].ID == target {
			return &profiles[i]
		}
	}

	if len(profiles) == 0 {
		return nil
	}
	return &profiles[0]
}

func applyDownloadActions(profile config.PathProfile, base DownloadDecision) DownloadDecision {
	actions := profile.Actions
	if actions == nil {
		return base
	}

	if vals := toStringSlice(actions["pathAction"]); len(vals) > 0 {
		base.PathAction = vals
	}
	if s := toString(actions["checkOriginMode"]); s != "" {
		base.CheckOriginMode = s
	}
	if s := toString(actions["fairQueueProfile"]); s != "" {
		base.FairQueueProfile = s
	}
	if s := toString(actions["throttleProfile"]); s != "" {
		base.ThrottleProfile = s
	}
	if v := toIntPointer(actions["maxSlotsPerIp"]); v != nil {
		base.MaxSlotsPerIpOverride = v
	}
	if v := toIntPointer(actions["maxWaitersPerIp"]); v != nil {
		base.MaxWaitersPerIpOverride = v
	}
	if s := toString(actions["blockReason"]); s != "" {
		base.BlockReason = &s
	}

	return base
}

func applyLandingActions(profile config.PathProfile, base LandingDecision, defaultCombo []string) LandingDecision {
	actions := profile.Actions
	if actions == nil {
		return base
	}

	if vals := toStringSlice(actions["captchaCombo"]); len(vals) > 0 {
		base.CaptchaCombo = vals
	} else if len(base.CaptchaCombo) == 0 && len(defaultCombo) > 0 {
		base.CaptchaCombo = append([]string{}, defaultCombo...)
	}
	if v := actions["fastRedirect"]; v != nil {
		if b, ok := v.(bool); ok {
			base.FastRedirect = b
		}
	}
	if v := actions["autoRedirect"]; v != nil {
		if b, ok := v.(bool); ok {
			base.AutoRedirect = b
		}
	}
	if s := toString(actions["blockReason"]); s != "" {
		base.BlockReason = &s
	}

	return base
}
