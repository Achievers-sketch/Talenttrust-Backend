# Request Limits Implementation Guide

## Summary

This implementation adds strict request body size limits and content-type enforcement middleware to the Talenttrust Backend to prevent large-payload DoS attacks and ensure proper content handling.

## Files Added/Modified

### New Files
- `src/middleware/requestLimits.ts` - Main middleware implementation
- `src/middleware/__tests__/requestLimits.test.ts` - Unit tests
- `src/requestLimits.integration.test.ts` - Integration tests
- `docs/request-limits-security.md` - Security documentation

### Modified Files
- `src/app.ts` - Integrated middleware into application
- `.env.example` - Added new environment variables

## Implementation Details

### Middleware Features

1. **Request Body Size Limits**
   - Default: 1MB maximum
   - Validates Content-Length header
   - Returns HTTP 413 for oversized requests

2. **Content-Type Enforcement**
   - Default: JSON-only (`application/json`)
   - Validates media type (ignores charset)
   - Returns HTTP 415 for invalid content-types
   - Excludes GET/HEAD requests

3. **Path Exclusions**
   - Default: `/health`, `/metrics`
   - Configurable via environment
   - Supports prefix matching

### Environment Configuration

```bash
# Request size limit (bytes)
MAX_REQUEST_BODY_SIZE=1048576

# Content-type enforcement
ENFORCE_JSON_CONTENT_TYPE=true
ALLOWED_CONTENT_TYPES=application/json

# Path exclusions
REQUEST_LIMITS_EXCLUDE_PATHS=/health,/metrics
```

### Rate Limiting (RFC 6585)

Rate limiting is enforced by the `src/middleware/rateLimiter.ts` middleware, which returns RFC 6585 compliant 429 Too Many Requests responses.

#### 429 Response Format

All 429 responses include:
- **HTTP Status**: 429 Too Many Requests
- **Retry-After Header**: Seconds to wait before retrying (required by RFC 6585)
- **X-RateLimit-* Headers**: Current rate limit state
  - `X-RateLimit-Limit`: Maximum requests allowed in the window
  - `X-RateLimit-Remaining`: Requests remaining in current window
  - `X-RateLimit-Reset`: Seconds until window resets
  - `X-RateLimit-Blocked`: `true` if client is hard-blocked (abuse detected)

#### Response Body (Safe Error Contract)

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests — please try again later",
    "requestId": "unique-correlation-id"
  }
}
```

**Security Notes:**
- Error messages follow the safe-error policy (`src/errors/safeErrors.ts`)
- No internal state or implementation details are leaked
- Messages are consistent regardless of block reason (rate limit vs. abuse)
- `requestId` allows clients to correlate with server logs

#### Client Backoff Guidance

Clients encountering 429 responses should:
1. **Check the `Retry-After` header** for the recommended wait time (in seconds)
2. **Respect exponential backoff**: Each successive violation doubles the block duration
3. **Monitor `X-RateLimit-Remaining`** on successful requests to pace load
4. **Read `X-RateLimit-Reset`** to understand when the window resets

Example client retry logic:
```javascript
async function makeRequestWithBackoff(url, options = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = (parseInt(retryAfter, 10) || 60) * 1000;
      console.log(`Rate limited. Waiting ${waitMs}ms before retry...`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    
    return response;
  }
  throw new Error('Rate limited after 3 attempts');
}
```

### Error Responses

All errors use the standard application error format:

```json
{
  "error": {
    "code": "payload_too_large" | "unsupported_media_type",
    "message": "Descriptive error message",
    "requestId": "unique-identifier"
  }
}
```

## Testing

### Test Coverage
- Unit tests: 100% coverage of middleware functions
- Integration tests: Full application testing
- Environment configuration tests
- Error handling validation
- Rate limit header verification
- Safe-error contract assertion

### Running Tests
```bash
npm run test:ci
npm run test:watch
```

### Specific Test Files
- `src/middleware/__tests__/requestLimits.test.ts` - Unit tests
- `src/requestLimits.integration.test.ts` - Integration tests
- `src/rateLimit.integration.test.ts` - Rate limiting integration tests

## Security Benefits

1. **DoS Prevention**: Limits request size to prevent memory exhaustion
2. **Content-Type Security**: Prevents parsing vulnerabilities
3. **Rate Limiting**: Protects against abuse and brute-force attacks
4. **Standardized Errors**: Consistent error handling prevents information leakage (RFC 6585)
5. **Configurable**: Environment-driven settings for different deployment needs

## Performance Impact

- Minimal overhead (header-only validation when possible)
- Early rejection of invalid requests
- No request body buffering
- Efficient string comparisons
- In-process rate limit store (no Redis dependency required)

## Migration Guide

### For Existing Applications
1. No breaking changes for valid requests
2. Invalid requests will now be rejected with proper error codes
3. Rate-limited requests return RFC 6585 compliant 429 responses
4. Configure environment variables as needed

### Recommended Settings
- **Development**: Default settings (1MB, JSON-only)
- **Staging**: Stricter limits (512KB) for testing
- **Production**: Conservative limits with monitoring

## Monitoring

### Key Metrics to Monitor
- Rate of 413 errors (payload too large)
- Rate of 415 errors (unsupported media type)
- Rate of 429 errors (rate limited)
- Average request size
- Request size distribution
- Number of hard-blocked clients

### Alerting
- High error rates may indicate attacks
- Monitor for abuse patterns
- Track geographic distribution of violations
- Alert on sustained 429 response rates

## Troubleshooting

### Common Issues

1. **Legitimate requests being rejected**
   - Check Content-Length header accuracy
   - Verify content-type configuration
   - Consider path exclusions if needed

2. **Clients receiving 429 responses**
   - Verify client is respecting `Retry-After` header
   - Check `X-RateLimit-Remaining` to understand budget
   - Review abuse patterns in logs

3. **Integration issues**
   - Ensure clients send proper Content-Type headers
   - Verify request sizes are within limits
   - Check environment variable configuration
   - Verify `requestId` correlation in logs

### Debugging
- Enable debug logging
- Monitor error responses and headers
- Test with different request sizes and content-types
- Simulate rate limit scenarios with load testing

## Future Considerations

1. **Dynamic Limits**: Per-endpoint configuration
2. **Rate Limiting Integration**: Combined validation
3. **Advanced Content-Type**: Schema validation
4. **Machine Learning**: Adaptive limit adjustment
5. **Distributed Rate Limiting**: Redis-backed store for multi-replica deployments
