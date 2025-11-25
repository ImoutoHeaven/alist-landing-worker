package metrics

import "log"

// Event is a single metrics record.
type Event struct {
	Type      string                 `json:"type"`
	Timestamp int64                  `json:"ts"`
	Data      map[string]interface{} `json:"data"`
}

// Batch is a batch of events from one source instance.
type Batch struct {
	Source     string  `json:"source"`
	Env        string  `json:"env"`
	InstanceID string  `json:"instance_id"`
	Events     []Event `json:"events"`
}

// Store defines a sink for metrics batches.
type Store interface {
	Append(batch Batch) error
}

// LogStore is a simple v0 implementation that logs batches.
type LogStore struct{}

func NewLogStore() *LogStore {
	return &LogStore{}
}

func (s *LogStore) Append(batch Batch) error {
	log.Printf("[metrics] source=%s env=%s instance=%s events=%d", batch.Source, batch.Env, batch.InstanceID, len(batch.Events))
	return nil
}
