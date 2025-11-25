package policy

// RequestContext describes request fields needed for decision.
type RequestContext struct {
	IP        string            `json:"ip"`
	ASN       int               `json:"asn"`
	Country   string            `json:"country"`
	Continent string            `json:"continent"`
	Method    string            `json:"method"`
	Host      string            `json:"host"`
	Path      string            `json:"path"`
	Query     string            `json:"query"`
	UserAgent string            `json:"userAgent"`
	Referer   string            `json:"referer"`
	Headers   map[string]string `json:"headers"`
}

// DecisionContext is the input to EvalDecision.
type DecisionContext struct {
	Role       string         `json:"role"`
	Env        string         `json:"env"`
	InstanceID string         `json:"instance_id"`
	Request    RequestContext `json:"request"`
}

// LandingDecision represents landing-side decision result.
type LandingDecision struct {
	CaptchaCombo []string `json:"captchaCombo"`
	FastRedirect bool     `json:"fastRedirect"`
	AutoRedirect bool     `json:"autoRedirect"`
	BlockReason  *string  `json:"blockReason"`
}

// DownloadDecision represents download-side decision result.
type DownloadDecision struct {
	PathAction              []string `json:"pathAction"`
	CheckOriginMode         string   `json:"checkOriginMode"`
	FairQueueProfile        string   `json:"fairQueueProfile"`
	ThrottleProfile         string   `json:"throttleProfile"`
	MaxSlotsPerIpOverride   *int     `json:"maxSlotsPerIpOverride"`
	MaxWaitersPerIpOverride *int     `json:"maxWaitersPerIpOverride"`
	BlockReason             *string  `json:"blockReason"`
}

// MetaInfo carries rule hits for debugging.
type MetaInfo struct {
	RuleIds []string `json:"ruleIds"`
	Tags    []string `json:"tags"`
	Explain []string `json:"explain"`
}

// DecisionResult is the decision API payload.
type DecisionResult struct {
	PolicyVersion string            `json:"policyVersion"`
	TTLSeconds    int               `json:"ttlSeconds"`
	Landing       *LandingDecision  `json:"landing"`
	Download      *DownloadDecision `json:"download"`
	Meta          MetaInfo          `json:"meta"`
}
