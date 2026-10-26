# Legacy provider lifecycle fixtures

The shared fixture runner covers success, malformed input, crash, stop,
uninstall, failed-upgrade rollback, and payload redaction. The adapter never
echoes request payloads and never reads ambient provider configuration.
