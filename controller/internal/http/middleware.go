package http

import (
	"net/http"
	"strings"
)

// AuthMiddleware validates Bearer tokens.
func AuthMiddleware(apiToken string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if apiToken == "" {
				http.NotFound(w, r)
				return
			}

			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") {
				http.NotFound(w, r)
				return
			}

			token := strings.TrimPrefix(auth, "Bearer ")
			if token != apiToken {
				http.NotFound(w, r)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
