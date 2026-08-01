# Load Testing Infrastructure Guide

This guide covers setting up load testing with k6 to ensure application scalability and identify performance bottlenecks for the BlueCollar API. The implementation lives in `packages/api/load/` with CI workflows in `.github/workflows/`.

## Architecture

```
k6 Load Scripts (packages/api/load/)
        ↓
API Endpoints (/api/*)
        ↓
Performance Metrics (custom Trends + built-in)
        ↓
CI Results (GitHub Artifacts + Step Summary)
```

## 1. k6 Installation

### 1.1 Local Installation

```bash
# macOS
brew install k6

# Linux
sudo apt-get install k6

# Docker
docker run -i grafana/k6 run - < script.js
```

### 1.2 k6 Scripts

The following k6 scripts are maintained under `packages/api/load/`:

| Script | Purpose | Endpoints |
|--------|---------|-----------|
| `search.js` | Search & discovery (read-heavy) | `GET /api/workers`, `GET /api/workers/:id`, `GET /api/categories`, `GET /api/workers?category=...` |
| `auth.js` | Authentication flows | `POST /api/auth/login` |
| `workers.js` | Worker CRUD (curator-gated writes) | `POST /api/workers`, update via method-override, `DELETE /api/workers/:id` |

## 2. Load Testing Scenarios

### 2.1 Search & Discovery (`packages/api/load/search.js`)

Covers the hot read paths: worker listing, single-worker lookup, categories, and filtered search.

```javascript
k6 run --env SCENARIO=load packages/api/load/search.js
```

**Available scenarios**: `smoke` (1 VU, 1 min), `load` (0→100 VUs), `stress` (0→300 VUs), `soak` (50 VUs, 30 min)

**SLOs**:
- `p(95) < 500ms` for worker list
- `p(95) < 300ms` for categories
- `p(95) < 400ms` for single worker
- `p(99) < 1500ms` globally
- `error rate < 2%`

### 2.2 Authentication (`packages/api/load/auth.js`)

Tests login endpoint performance using invalid credentials (non-destructive).

```bash
k6 run packages/api/load/auth.js
k6 run --env BASE_URL=https://staging.bluecollar.app/api packages/api/load/auth.js
```

**SLOs**:
- `p(95) < 800ms` for login
- `error rate < 5%`

### 2.3 Worker CRUD (`packages/api/load/workers.js`)

Tests curator-gated write paths with proper authentication and cleanup.

```bash
k6 run --env AUTH_TOKEN=<jwt> packages/api/load/workers.js
```

**SLOs**:
- `p(95) < 1000ms` for writes
- `p(99) < 2000ms` globally
- `error rate < 5%`

**Note**: Falls back to read-only mode (GET /workers) when no `AUTH_TOKEN` is provided.

## 3. Running Load Tests

### 3.1 Smoke Test (PR validation)

```bash
k6 run --env SCENARIO=smoke packages/api/load/search.js
k6 run packages/api/load/auth.js
```

### 3.2 Nightly Load Test

```bash
k6 run --env SCENARIO=load packages/api/load/search.js
k6 run packages/api/load/auth.js
k6 run --env AUTH_TOKEN=<jwt> packages/api/load/workers.js
```

### 3.3 With Custom Base URL

```bash
BASE_URL=https://staging.bluecollar.app/api k6 run packages/api/load/search.js
```

### 3.4 Docker Execution

```bash
docker run -i grafana/k6 run \
  --env BASE_URL=http://localhost:3000/api \
  - < packages/api/load/search.js
```

## 4. Load Test Results Analysis

### 4.1 Key Metrics

- **Response Time (p95, p99)**: Percentile response times
- **Error Rate**: Percentage of failed requests
- **Throughput**: Requests per second
- **Virtual Users**: Concurrent users during test

### 4.2 Interpreting Results

```
✓ http_req_duration: p(95)<500ms ✓ 95% of requests completed in < 500ms
✓ http_req_failed: rate<0.1 ✓ Less than 10% of requests failed
✓ checks: 99.5% ✓ 99.5% of checks passed
```

### 4.3 Performance Bottlenecks

Common issues identified:
- High response times (> 1000ms)
- High error rates (> 5%)
- Memory leaks under load
- Database connection pool exhaustion
- CPU saturation

## 5. Continuous Load Testing

### 5.1 Nightly Load Tests (`.github/workflows/load.yml`)

```yaml
name: Load Testing

on:
  pull_request:
    paths:
      - "packages/api/load/**"
      - "packages/api/src/**"
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:
    inputs:
      scenario:  # smoke | load | stress | soak
      base_url:  # Custom API endpoint
```

**Jobs**:
- **Smoke Test (PR Only)**: Fast (`smoke` profile) runs on every PR — validates thresholds
- **Nightly Load Test**: Full suite (search + auth + workers) with configurable scenarios

### 5.2 Performance Testing (`.github/workflows/performance.yml`)

```yaml
name: Performance Testing

on:
  pull_request:
    paths:
      - "packages/api/load/**"
      - "packages/api/src/**"
```

**Job**: `performance` — runs on every PR with a shortened `load` profile (~5 min) to catch regressions early.

### 5.3 Docker Compose Integration

Add to `docker-compose.yml`:

```yaml
load-tester:
  image: grafana/k6:latest
  restart: 'no'
  depends_on:
    - api
  environment:
    BASE_URL: http://api:3000/api
  volumes:
    - ./packages/api/load:/scripts:ro
  command: run /scripts/search.js
  networks:
    - internal
```

## 6. Performance Optimization Recommendations

Based on load test results:

1. **Response Time > 500ms**
   - Add database indexes
   - Implement caching
   - Optimize queries

2. **Error Rate > 5%**
   - Check error logs
   - Increase timeout values
   - Scale API instances

3. **High Memory Usage**
   - Profile memory leaks
   - Reduce cache size
   - Optimize data structures

4. **CPU Saturation**
   - Add more CPU cores
   - Optimize algorithms
   - Implement load balancing

## 7. Load Testing Best Practices

- Run tests during off-peak hours
- Test against production-like environment
- Gradually increase load
- Monitor system resources during tests
- Document baseline performance
- Run tests regularly (weekly/monthly)
- Share results with team
- Use results to guide optimization efforts
