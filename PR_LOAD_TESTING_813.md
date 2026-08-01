# Load Testing Implementation - Issue #813

## Overview
This PR implements comprehensive k6 load and stress testing infrastructure for the BlueCollar API, addressing issue #813: "[Testing] Load & Stress Testing with k6".

## Acceptance Criteria Met

### k6 scripts cover key endpoints
- **Search & Discovery**: `packages/api/load/search.js`
  - `GET /api/workers` - Worker listing (paginated, filtered, cached)
  - `GET /api/workers/:id` - Single worker lookup (cached)
  - `GET /api/categories` - Category listing (cached)
  - `GET /api/workers?category=plumber&page=1&limit=20` - Filtered/worker search
- **Worker CRUD**: `packages/api/load/workers.js`
  - `POST /api/workers` - Create worker (curator-gated)
  - `POST /api/workers/:id` + `X-HTTP-Method: PUT` - Update worker (method-override)
  - `DELETE /api/workers/:id` - Delete worker (curator-gated)
- **Authentication**: `packages/api/load/auth.js`
  - `POST /api/auth/login` - User authentication (invalid credentials – non-destructive)

### Thresholds fail the run on regression
All scripts include SLO-based thresholds that automatically fail CI on performance regression:

#### Search & Discovery SLOs (`search.js`):
- `p(95) < 500ms` for worker list endpoint
- `p(95) < 300ms` for categories endpoint
- `p(95) < 400ms` for single worker endpoint
- `p(99) < 1500ms` globally
- `error rate < 2%`

#### Worker CRUD SLOs (`workers.js`):
- `p(95) < 1000ms` for write operations
- `p(99) < 2000ms` globally
- `error rate < 5%`

#### Authentication SLOs (`auth.js`):
- `p(95) < 800ms` for login endpoint
- `error rate < 5%`

### Nightly results published
- **GitHub Actions workflow**: `.github/workflows/load.yml` (workflow: "Load Testing")
- **Schedule**: Runs nightly at 02:00 UTC via cron
- **Manual triggers**: Supports `workflow_dispatch` with custom scenarios (smoke, load, stress, soak)
- **Results storage**: Uploads test results as artifacts with 30-day retention
- **Reporting**: Generates performance summary in GitHub Actions step summary
- **Worker CRUD**: Includes `workers.js` in the nightly run (requires `LOAD_TEST_AUTH_TOKEN` secret for write operations)

### PR smoke test
- **GitHub Actions workflow**: `.github/workflows/load.yml` (job: "Smoke Test (PR Only)")
- Triggers on every PR touching `packages/api/**` or load scripts
- Runs a fast `smoke` profile (1 VU, 1 minute) for search and auth endpoints
- Uploads results with 7-day retention

### Performance Testing workflow (PR-level)
- **GitHub Actions workflow**: `.github/workflows/performance.yml` (workflow: "Performance Testing")
- Job: `performance` — runs on every PR
- Uses a shortened `load` profile for fast feedback (~5 min)
- Validates all SLO thresholds against staging/local API
- Uploads results with 14-day retention
- Generates a structured performance summary table in GitHub Actions

## Implementation Details

### Load Test Scenarios

#### 1. Search & Discovery (`packages/api/load/search.js`)
Scenario profiles: smoke, load, stress, soak

```javascript
export const options = {
  scenarios: {
    [SCENARIO]: PROFILES[SCENARIO] ?? PROFILES.load,
  },
  thresholds: {
    http_req_duration:    ['p(99)<1500'],
    http_req_failed:      ['rate<0.02'],
    error_rate:           ['rate<0.02'],
    worker_list_duration: ['p(95)<500'],
    category_duration:    ['p(95)<300'],
    single_worker_duration: ['p(95)<400'],
  },
};
```

**Load Profile**: Ramps to 50 VUs over 2 min, sustains for 5 min, then scales to 100 VUs for 5 min
**Stress Profile**: Ramps to 300 VUs over 5 stages to test breaking points
**Soak Profile**: 50 VUs for 30 min to test memory leaks
**Smoke Profile**: 1 VU for 1 min — PR-fast validation

#### 2. Worker CRUD (`packages/api/load/workers.js`)
Tests curator-gated write paths under load:
- Creates test workers with realistic data
- Updates using method-override pattern (`X-HTTP-Method: PUT`)
- Cleans up by deleting created records
- Requires `AUTH_TOKEN` environment variable for curator access
- Falls back to read-only mode when no token is provided

#### 3. Authentication (`packages/api/load/auth.js`)
Tests login endpoint performance without side effects:
- Uses invalid credentials to measure response time
- Validates proper error responses (400/401/422)
- Measures authentication latency under load

### CI/CD Integration

#### Load Testing Workflow (`.github/workflows/load.yml`)
```yaml
name: Load Testing

on:
  pull_request:
    paths:
      - "packages/api/load/**"
      - "packages/api/src/**"
      - ".github/workflows/load.yml"
  schedule:
    - cron: "0 2 * * *"  # Daily at 02:00 UTC
  workflow_dispatch:
    inputs:
      scenario: # smoke | load | stress | soak
      base_url: # Custom API endpoint
```

**Features**:
- Multi-scenario support (smoke, load, stress, soak)
- Configurable base URL for different environments
- JSON output for trend analysis
- Artifact upload (30-day retention for nightly, 7-day for PR smoke)
- Performance summary generation in step summary
- Fallback to local Docker Compose when staging URL is not configured

#### Performance Testing Workflow (`.github/workflows/performance.yml`)
```yaml
name: Performance Testing

on:
  pull_request:
    paths:
      - "packages/api/load/**"
      - "packages/api/src/**"
      - ".github/workflows/performance.yml"
```

**Features**:
- PR-level performance regression detection
- Runs search and auth load tests with shortened profiles
- Structured summary table with PASS/FAIL per metric
- Results persisted as artifacts for 14 days

### Usage Examples

#### Local Development
```bash
# Install k6
brew install k6  # macOS
# or
sudo apt-get install k6  # Linux

# Run search load test
k6 run --env SCENARIO=load packages/api/load/search.js

# Run against staging
k h run --env BASE_URL=https://staging.bluecollar.app/api packages/api/load/search.js

# Run worker CRUD with auth
k6 run --env AUTH_TOKEN=<jwt> packages/api/load/workers.js

# Run smoke test (fast, for PRs)
k6 run --env SCENARIO=smoke packages/api/load/search.js
```

#### CI Environment Variables
- `BASE_URL`: API endpoint (defaults to staging)
- `SCENARIO`: Test scenario (smoke/load/stress/soak)
- `AUTH_TOKEN`: Curator JWT for write operations (workers.js)
- `STAGING_API_URL`: Secret for staging environment URL

## Performance Baselines

### Expected Performance Targets
- **Worker List**: p95 < 500ms (handles pagination, filtering)
- **Categories**: p95 < 300ms (lightweight endpoint)
- **Single Worker**: p95 < 400ms (database lookup + caching)
- **Login**: p95 < 800ms (includes password hashing)
- **Worker CRUD**: p95 < 1000ms (database writes)

### Load Capacity
- **Smoke Test**: 1 VU, 1 min (PR validation)
- **Normal Load**: 50-100 VUs (CI performance check)
- **Stress Test**: 300 VUs (breaking point identification)
- **Soak Test**: 50 VUs for 30 min (stability validation)

## Technical Implementation

### Custom Metrics
```javascript
// Endpoint-specific performance tracking
const errorRate = new Rate('error_rate');
const workerListP95 = new Trend('worker_list_duration', true);
const categoryP95 = new Trend('category_duration', true);
const singleWorkerP95 = new Trend('single_worker_duration', true);
```

### Smart Setup Phase (search.js)
```javascript
export function setup() {
  // Fetches real worker ID for single-worker tests
  const res = http.get(`${BASE}/workers?limit=1`);
  return { workerId: workers[0]?.id };
}
```

### Method Override Support (workers.js)
Properly handles BlueCollar's method-override pattern for worker updates:
```javascript
http.post(`${BASE}/workers/${workerId}`, payload, {
  headers: { ...auth, 'X-HTTP-Method': 'PUT' }
});
```

### Non-Destructive Design
1. **Auth tests**: Use invalid credentials — no side effects
2. **Worker CRUD tests**: Delete created records after testing
3. **Rate limiting awareness**: Includes proper sleep intervals
4. **Error handling**: Graceful degradation on setup failures
5. **Environment isolation**: Configurable base URLs

## Monitoring & Alerting

### Key Metrics Tracked
- Response time percentiles (p95, p99)
- Error rates by endpoint
- Throughput (requests/second)
- Virtual user concurrency

### Failure Conditions
- Response time regression (thresholds fail the run)
- Error rate spikes (>threshold)
- Timeout increases
- Memory/resource exhaustion (detected via soak tests)

## Next Steps

1. **Baseline establishment**: Run initial load tests to establish performance baselines
2. **Alerting setup**: Configure notifications for performance regressions
3. **Trend analysis**: Implement historical performance tracking
4. **Capacity planning**: Use results to guide infrastructure scaling
5. **SLO refinement**: Adjust thresholds based on production requirements

## Documentation

- **Load Testing Guide**: `docs/LOAD_TESTING_GUIDE.md`
- **k6 Scripts**: `packages/api/load/` (search.js, auth.js, workers.js)
- **CI Workflow**: `.github/workflows/load.yml`
- **Performance Workflow**: `.github/workflows/performance.yml`
- **API Documentation**: `packages/api/DOCUMENTATION.json`

## Resolves

Closes #813 - [Testing] Load & Stress Testing with k6

**All acceptance criteria have been implemented:**
- k6 scripts cover key endpoints
- Thresholds fail the run on regression
- Nightly results published
- PR smoke test for fast feedback
- Performance Testing workflow for regression detection