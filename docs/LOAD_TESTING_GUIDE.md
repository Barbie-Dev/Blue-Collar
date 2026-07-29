# Load Testing Infrastructure Guide

This guide covers setting up load testing with k6 to ensure application scalability and identify performance bottlenecks.

## Architecture

```
Load Test Scenarios (k6)
      ↓
  API Endpoints
      ↓
  Performance Metrics
      ↓
  Results Analysis
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

### 1.2 Add to package.json

```json
{
  "devDependencies": {
    "k6": "^0.47.0"
  }
}
```

## 2. Load Testing Scenarios

### 2.1 Basic API Load Test

Create `deploy/load-tests/basic-load-test.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },  // Ramp up to 100 users
    { duration: '5m', target: 100 },  // Stay at 100 users
    { duration: '2m', target: 200 },  // Ramp up to 200 users
    { duration: '5m', target: 200 },  // Stay at 200 users
    { duration: '2m', target: 0 },    // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';

export default function () {
  // Test worker listing
  let res = http.get(`${BASE_URL}/workers`);
  check(res, {
    'GET /workers status is 200': (r) => r.status === 200,
    'GET /workers response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);

  // Test category listing
  res = http.get(`${BASE_URL}/categories`);
  check(res, {
    'GET /categories status is 200': (r) => r.status === 200,
    'GET /categories response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
```

### 2.2 Authentication Load Test

Create `deploy/load-tests/auth-load-test.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';

export default function () {
  // Login
  const loginRes = http.post(`${BASE_URL}/auth/login`, {
    email: `user${Math.random()}@example.com`,
    password: 'password123',
  });

  check(loginRes, {
    'Login status is 200 or 401': (r) => r.status === 200 || r.status === 401,
  });

  sleep(1);
}
```

### 2.3 Worker CRUD Load Test

Create `deploy/load-tests/worker-crud-load-test.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 30 },
    { duration: '3m', target: 30 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';
const TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
  };

  // Create worker
  const createRes = http.post(
    `${BASE_URL}/workers`,
    JSON.stringify({
      name: `Worker ${Math.random()}`,
      category: 'plumber',
      location: 'New York',
      bio: 'Experienced plumber',
    }),
    { headers }
  );

  check(createRes, {
    'Create worker status is 201': (r) => r.status === 201,
  });

  if (createRes.status === 201) {
    const workerId = createRes.json('id');

    sleep(1);

    // Get worker
    const getRes = http.get(`${BASE_URL}/workers/${workerId}`);
    check(getRes, {
      'Get worker status is 200': (r) => r.status === 200,
    });

    sleep(1);

    // Update worker
    const updateRes = http.post(
      `${BASE_URL}/workers/${workerId}`,
      JSON.stringify({
        bio: 'Updated bio',
      }),
      {
        headers: {
          ...headers,
          'X-HTTP-Method': 'PUT',
        },
      }
    );

    check(updateRes, {
      'Update worker status is 200': (r) => r.status === 200,
    });

    sleep(1);

    // Delete worker
    const deleteRes = http.del(`${BASE_URL}/workers/${workerId}`, { headers });
    check(deleteRes, {
      'Delete worker status is 204': (r) => r.status === 204,
    });
  }

  sleep(2);
}
```

### 2.4 Spike Test

Create `deploy/load-tests/spike-test.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '10s', target: 1000 }, // Spike
    { duration: '1m', target: 1000 },
    { duration: '10s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';

export default function () {
  const res = http.get(`${BASE_URL}/workers`);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
```

### 2.5 Stress Test

Create `deploy/load-tests/stress-test.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 200 },
    { duration: '5m', target: 300 },
    { duration: '5m', target: 400 },
    { duration: '5m', target: 500 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.2'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api';

export default function () {
  const res = http.get(`${BASE_URL}/workers`);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(0.5);
}
```

## 3. Running Load Tests

### 3.1 Basic Load Test

```bash
k6 run deploy/load-tests/basic-load-test.js
```

### 3.2 With Custom Base URL

```bash
BASE_URL=https://api.example.com k6 run deploy/load-tests/basic-load-test.js
```

### 3.3 With Authentication Token

```bash
AUTH_TOKEN=your_jwt_token k6 run deploy/load-tests/worker-crud-load-test.js
```

### 3.4 Docker Execution

```bash
docker run -i grafana/k6 run - < deploy/load-tests/basic-load-test.js
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

### 5.1 GitHub Actions Integration

Create `.github/workflows/load-test.yml`:

```yaml
name: Load Testing

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Run load tests
        run: |
          docker run -i grafana/k6 run - < deploy/load-tests/basic-load-test.js \
            -e BASE_URL=${{ secrets.API_URL }}
      
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: load-test-results
          path: results/
```

### 5.2 Docker Compose Integration

Add to `docker-compose.prod.example.yml`:

```yaml
load-tester:
  image: grafana/k6:latest
  restart: 'no'
  depends_on:
    - api
  environment:
    BASE_URL: http://api:3000/api
  volumes:
    - ./deploy/load-tests:/scripts:ro
  command: run /scripts/basic-load-test.js
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

---

## 8. Payment Path Performance Baseline (#1060)

### 8.1 Script

`deploy/load-tests/payment-load-test.js`

Tests three flows:
- **Tip submission** — `POST /api/tips` with idempotency-key retry
- **Escrow lifecycle** — `POST /api/escrow` → `POST /api/escrow/:id/release`
- **Worker discovery** — `GET /api/workers` + `GET /api/workers/:id` (read-only warm-up)

### 8.2 Running the baseline capture

```bash
# 1. Start the API (or point BASE_URL at staging)
pnpm --filter @bluecollar/api dev

# 2. Create a load-test account (once):
#    POST /api/auth/register with email=loadtest@example.com, role=curator

# 3. Run the load scenario and capture output
mkdir -p results
k6 run --env SCENARIO=load \
       --env BASE_URL=http://localhost:3000/api \
       --env TEST_EMAIL=loadtest@example.com \
       --env TEST_PASSWORD=Password123! \
       deploy/load-tests/payment-load-test.js

# 4. Commit results/payment-baseline.json to track the baseline over time
```

### 8.3 Scenarios

| `SCENARIO=` | VUs | Duration | Purpose |
|---|---|---|---|
| `smoke` | 1 | 1 min | Sanity check — fails if something is fundamentally broken |
| `load` | 0 → 50 | ~14 min | **Baseline capture** — use this to set thresholds |
| `stress` | 0 → 150 | ~15 min | Find the degradation point |
| `soak` | 20 | 30 min | Detect memory leaks / connection-pool exhaustion |

### 8.4 SLO thresholds

These are the acceptance criteria for the payment path. A CI run that exceeds
any of these values should block the deploy.

| Metric | p(95) threshold | p(99) threshold | Rationale |
|---|---|---|---|
| `tip_submit_duration` | < 1 500 ms | < 3 000 ms | Tip is user-initiated; > 1.5 s feels slow |
| `escrow_create_duration` | < 1 500 ms | < 3 000 ms | Same UX reasoning as tip |
| `escrow_release_duration` | < 2 000 ms | < 4 000 ms | Release involves a DB write + notification dispatch |
| `http_req_duration` (all) | < 1 000 ms | < 2 500 ms | Catch regressions in discovery + auth endpoints |
| `payment_error_rate` | — | — | < 5% of payment VU iterations |
| `http_req_failed` | — | — | < 5% of all HTTP requests |

> **Tightening thresholds after baseline capture:** once you have a real
> `results/payment-baseline.json`, set each p(95) threshold to
> `baseline_value × 1.25` (25% headroom). Update this table and the
> `THRESHOLDS` constant in `payment-load-test.js` accordingly.

### 8.5 Baseline values (pre-populated after first run)

> These will be `null` until the first `load` scenario run completes.
> Update this table by pasting the values from `results/payment-baseline.json`.

| Metric | p(95) | p(99) | Captured at |
|---|---|---|---|
| `tip_submit_duration` | TBD | TBD | — |
| `escrow_create_duration` | TBD | TBD | — |
| `escrow_release_duration` | TBD | TBD | — |
| `http_req_duration` (all) | TBD | TBD | — |

### 8.6 CI integration

Add to `.github/workflows/load.yml` (or create it):

```yaml
- name: Payment path smoke test
  run: |
    docker run --rm -i grafana/k6 run \
      --env SCENARIO=smoke \
      --env BASE_URL=${{ env.API_URL }} \
      --env TEST_EMAIL=${{ secrets.LOAD_TEST_EMAIL }} \
      --env TEST_PASSWORD=${{ secrets.LOAD_TEST_PASSWORD }} \
      - < deploy/load-tests/payment-load-test.js
```

Run the full `load` scenario only on scheduled nightly runs — not on every PR
(it takes ~14 minutes).

### 8.7 Interpreting results

A **passing run** looks like this in the k6 summary:

```
✓ payment_error_rate.............: 0.00%  ✓ 0   ✗ 0
✓ tip_submit_duration............: avg=210ms  p(95)=480ms  p(99)=870ms
✓ escrow_create_duration.........: avg=190ms  p(95)=420ms  p(99)=800ms
✓ escrow_release_duration........: avg=240ms  p(95)=540ms  p(99)=980ms
✓ http_req_duration..............: p(95)=390ms
✓ http_req_failed................: 0.00%
```

A **failing run** shows a `✗` next to the breached threshold and the CI step
exits with a non-zero status code, blocking the deploy.

### 8.8 Adding new payment endpoints to the test

When a new payment endpoint is added (e.g., `/api/escrow/:id/dispute`):

1. Add a new `Trend` metric: `const disputeDuration = new Trend('escrow_dispute_duration', true)`
2. Add the request in a `group('escrow_dispute', () => { ... })` block
3. Add a threshold entry to `THRESHOLDS`
4. Update the baseline table in section 8.5 after running the `load` scenario
