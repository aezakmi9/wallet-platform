import http from 'k6/http';
import {check, sleep} from 'k6';
import {Trend} from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;
const USERS = 10;
const CURRENCY = 'USD';
const INITIAL_BALANCE = 1000000;
const TRANSFER_TAG = 'POST /api/transfers';
const OUTBOX_TAG = 'GET /api/outbox-events';
const JSON_HEADERS = {'Content-Type': 'application/json'};


const outboxPending = new Trend('outbox_pending');

export const options = {
    setupTimeout: '120s',
    teardownTimeout: '90s',
    scenarios: {
                transfers: {
            executor: 'constant-arrival-rate',
            exec: 'transfers',
            rate: 50,
            timeUnit: '1s',
            duration: '2m',
            preAllocatedVUs: 20,
            maxVUs: 100,
        },
        outbox: {
            executor: 'constant-vus',
            exec: 'pollOutbox',
            vus: 1,
            duration: '2m30s',
        },
    },
        thresholds: {
        [`http_req_failed{name:${TRANSFER_TAG}}`]: ['rate<0.01'],
        outbox_pending: ['p(95)<200', 'max<500'],
        checks: ['rate>0.99'],
        dropped_iterations: ['count<10'],
    },
};

function authHeaders(token) {
    return {...JSON_HEADERS, Authorization: `Bearer ${token}`};
}

function expectStatus(response, status, what) {
    if (response.status !== status) {
        throw new Error(`${what} failed: ${response.status} ${response.body}`);
    }
}


function adminLogin() {
    if(!ADMIN_EMAIL || !ADMIN_PASSWORD) {
        throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (the admin seeded on startup)');
    }

    const response = http.post(
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({email:ADMIN_EMAIL, password:ADMIN_PASSWORD}),
        {headers: JSON_HEADERS},
    );
    expectStatus(response,200,'Admin login');
    return response.json('payload.accessToken');
}


function countOutbox(adminToken, status) {
    const response = http.get(
        `${BASE_URL}/api/outbox-events?status=${status}&size=1`,
        {headers: authHeaders(adminToken), tags: {name: OUTBOX_TAG}},
    );

    expectStatus(response, 200, `Count ${status} outbox events`);
    return response.json('payload.totalElements');
}

export function setup() {
    const adminToken = adminLogin();

    return {
        adminToken,
        failedBefore: countOutbox(adminToken,'FAILED'),
        sessions: USERS.map((user,i)=> ({
            token:user.token,
            fromAccountId: user.accountId,
            toAccountId: users[(i+1) % USERS.lentgh].accountId,
        })),
    };
}

export function trasfers(data) {
    const user = data,sessions[exec.scenarios.iterationInTest % data.sessions.lentgh];

    transfer(user.token, user.fromAccountId, user.toAccountId);
}

export function pollOutbox(data) {
    outboxPending.add(countOutbox(data.adminToken,'PENDING'));
    sleep(1);
}

export function teardown(data) {
    let pending = countOutbox(data.adminToken, 'PENDING');
    for(let attempt = 0;
        attempt < 60 && pending > 0; attempt++
    ) {
        sleep(1);
        pending = countOutbox(data.adminToken,'PEDING');
    }

    check(pending, {'outbox drained afterload': (p)=> p ===0});
    check(countOutbox(data.adminToken,'FAILED'), {
        'no new FAILED outbox events': failed => failed ===data.failedBefore,
    });
}

