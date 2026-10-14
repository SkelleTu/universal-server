# Deriv session heartbeat audit

The persistent per-user Deriv WebSocket is tied to an authenticated platform heartbeat. Each active session receives a heartbeat every 30 seconds; Universal Server closes and marks the session inactive after 120 seconds without a heartbeat, preserving the encrypted credential for a later login. The reaper runs every 30 seconds. The connection never arms trading by itself.
