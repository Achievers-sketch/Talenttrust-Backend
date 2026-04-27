# Event Ingestion Idempotency Documentation

## Overview

The Talenttrust backend implements an idempotent contract event ingestion pipeline that guarantees safe event processing with strict schema validation, deduplication, and comprehensive auditability.

## Architecture

### Core Components

1. **Event Validation Layer** - Validates event structure and contract-specific schemas
2. **Deduplication Manager** - Computes stable deduplication keys and payload hashes
3. **Audit Repository** - Persists processing outcomes for auditability
4. **Ingestion Service** - Orchestrates the entire pipeline with idempotency guarantees

## Idempotency Mechanism

### Deduplication Key Format

The system uses a stable deduplication key format: `contractId:eventId:sequence`

Example: `talent_contract_123:profile_created:1`

This ensures that:
- Events from the same contract are uniquely identified
- Event replay scenarios are handled safely
- Sequence ordering is preserved within contracts

### Payload Integrity Verification

For enhanced security, the system computes SHA-256 hashes of event payloads:
- Payloads are JSON-stringified with sorted keys for consistency
- Hashes are stored for integrity verification
- Tampered payloads are rejected even with valid deduplication keys

## Event Schemas

### Base Event Structure

```typescript
interface ContractEvent {
  contractId: string;      // Unique contract identifier
  eventId: string;         // Unique event identifier within contract
  sequence: number;        // Monotonically increasing sequence number
  timestamp: number;       // Unix timestamp (milliseconds)
  payload: object;          // Event-specific data
  signature?: string;      // Optional cryptographic signature
}
```

### Contract-Specific Payload Schemas

#### Talent Contract Events

```typescript
interface TalentEventPayload {
  talentId: string;         // Required: Talent identifier
  action: 'created' | 'updated' | 'verified' | 'terminated';
  metadata?: object;        // Optional: Additional context
}
```

#### Payment Contract Events

```typescript
interface PaymentEventPayload {
  paymentId: string;       // Required: Payment identifier
  amount: number;           // Required: Payment amount (>= 0)
  currency: string;         // Required: Currency code
  status: 'pending' | 'completed' | 'failed';
  timestamp: number;        // Required: Payment timestamp
}
```

#### Review Contract Events

```typescript
interface ReviewEventPayload {
  reviewId: string;        // Required: Review identifier
  reviewerId: string;      // Required: Reviewer identifier
  rating: number;           // Required: 1-5 rating
  comment?: string;         // Optional: Review text
  createdAt: number;        // Required: Review creation timestamp
}
```

## API Endpoints

### Event Ingestion

**POST** `/api/v1/events`

Processes a batch of events with full idempotency guarantees.

**Request Body:**
```json
{
  "events": [ContractEvent[]],
  "contractType": "talent_contract" | "payment_contract" | "review_contract"
}
```

**Response:**
```json
{
  "processed": 3,
  "results": [{
    "deduplicationKey": "contract_123:event_456:1",
    "status": "accepted" | "rejected" | "duplicate",
    "reason": "Optional error description",
    "processedAt": "2023-01-01T00:00:00.000Z"
  }],
  "summary": {
    "accepted": 2,
    "rejected": 0,
    "duplicates": 1
  }
}
```

### Event Validation (Dry Run)

**POST** `/api/v1/events/validate`

Validates events without processing them.

**Request Body:**
```json
{
  "event": ContractEvent,
  "contractType": string
}
```

**Response:**
```json
{
  "isValid": true,
  "errors": []
}
```

### Processing Statistics

**GET** `/api/v1/stats`

Returns processing statistics.

**Response:**
```json
{
  "total": 1000,
  "accepted": 850,
  "rejected": 100,
  "duplicates": 50
}
```

### Contract History

**GET** `/api/v1/contracts/{contractId}/history`

Retrieves processing history for a specific contract.

**Response:** `EventProcessingAudit[]`

## Configuration

### Environment Variables

```bash
# Enable/disable strict contract-specific validation
ENABLE_STRICT_VALIDATION=true

# Enable/disable payload integrity checks
ENABLE_PAYLOAD_INTEGRITY_CHECK=true

# Maximum age for events (milliseconds)
MAX_EVENT_AGE_MS=86400000

# Batch processing size
EVENT_BATCH_SIZE=100
```

### Processing Behavior

- **Strict Validation**: When enabled, validates payloads against contract-specific schemas
- **Payload Integrity**: When enabled, detects payload tampering in duplicate events
- **Event Age**: Rejects events older than configured threshold
- **Batch Size**: Controls parallel processing batch size for performance optimization

## Error Handling

### Validation Errors

Events are rejected for:
- Missing required fields
- Invalid data types
- Contract-specific schema violations
- Events exceeding age limits

### Idempotency Errors

- **Duplicate Events**: Same deduplication key already processed
- **Integrity Failures**: Payload hash mismatch for duplicate events

### Processing Errors

- System errors are caught and logged
- Events are rejected with descriptive error messages
- Audit trail is maintained for all outcomes

## Security Considerations

1. **Input Validation**: All inputs are strictly validated
2. **Payload Integrity**: Optional cryptographic verification
3. **Audit Trail**: Complete processing history maintained
4. **Rate Limiting**: Consider implementing for production
5. **Authentication**: Add API authentication as needed

## Performance Characteristics

- **Deduplication Check**: O(1) lookup using in-memory index
- **Batch Processing**: Parallel processing within configurable batch sizes
- **Memory Usage**: Linear with number of unique events
- **Scalability**: Consider database persistence for production scale

## Monitoring and Observability

### Metrics to Monitor

- Event processing rate (events/second)
- Acceptance/rejection ratios
- Duplicate event frequency
- Processing latency
- Error rates by category

### Health Checks

- `/health` endpoint provides service status
- Consider adding database connectivity checks
- Monitor memory usage for large event volumes

## Testing

The implementation includes comprehensive tests with 95%+ coverage:

- Unit tests for all core components
- Integration tests for API endpoints
- Idempotency behavior verification
- Error condition handling
- Performance benchmarks

Run tests with:
```bash
npm run test:ci    # Full test suite with coverage
npm run test:watch  # Watch mode during development
```

## Migration and Deployment

### Database Migration

When moving from in-memory to persistent storage:

1. Implement `IEventAuditRepository` with database backend
2. Add migration scripts for existing audit data
3. Update dependency injection configuration
4. Test with production data volumes

### Deployment Considerations

- Health check configuration
- Environment-specific settings
- Database connection pooling
- Monitoring and alerting setup
- Load balancing for high availability

## Troubleshooting

### Common Issues

1. **High Duplicate Rates**: Check event sequence generation
2. **Validation Failures**: Review schema definitions
3. **Performance Issues**: Monitor batch sizes and database queries
4. **Memory Usage**: Consider database persistence for large volumes

### Debug Information

- Enable debug logging for detailed processing information
- Use validation endpoint for testing event formats
- Monitor audit records for processing patterns
- Check deduplication key generation logic
