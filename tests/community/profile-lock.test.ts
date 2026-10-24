import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoreApp, createCoreTestDb } from "../../packages/server-core/src/index.ts";
import { signPhone, signTv } from "../../packages/server-core/src/auth/jwt.ts";

test("profile PIN unlock and profile switch requests enforce household boundaries", async () => {
  const db = await createCoreTestDb();
  const householdA = randomUUID();
  const householdB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const profileA = randomUUID();
  const profileB = randomUUID();
  const tvA = randomUUID();
  const tvB = randomUUID();

  await db.query(
    `INSERT INTO households (id, name, created_by_user_id, profile_lock)
     VALUES ($1, 'Household A', $2, TRUE), ($3, 'Household B', $4, TRUE)`,
    [householdA, userA, householdB, userB],
  );
  await db.query(
    `INSERT INTO users (id, email, household_id)
     VALUES ($1, NULL, $2), ($3, NULL, $4)`,
    [userA, householdA, userB, householdB],
  );
  await db.query(
    `INSERT INTO profiles (id, household_id, name, sort_order)
     VALUES ($1, $2, 'Living room', 0), ($3, $4, 'Living room', 0)`,
    [profileA, householdA, profileB, householdB],
  );
  await db.query(
    `INSERT INTO devices (id, household_id, kind, display_name, secret_hash)
     VALUES ($1, $2, 'tv', 'TV A', 'test-secret-a'), ($3, $4, 'tv', 'TV B', 'test-secret-b')`,
    [tvA, householdA, tvB, householdB],
  );

  const app = await buildCoreApp(db);
  const phoneA = { authorization: `Bearer ${await signPhone(userA, householdA)}` };
  const phoneB = { authorization: `Bearer ${await signPhone(userB, householdB)}` };
  const tvAuthA = { authorization: `Bearer ${await signTv(tvA, householdA)}` };
  const tvAuthB = { authorization: `Bearer ${await signTv(tvB, householdB)}` };

  try {
    const createPinProfile = await app.inject({
      method: "POST",
      url: "/api/profiles",
      headers: phoneA,
      payload: { name: "PIN protected", pin: "4826" },
    });
    assert.equal(createPinProfile.statusCode, 201, createPinProfile.body);
    const pinProfileId = createPinProfile.json().id as string;

    const correctPin = await app.inject({
      method: "POST",
      url: `/api/profiles/${pinProfileId}/unlock`,
      headers: phoneA,
      payload: { pin: "4826" },
    });
    assert.equal(correctPin.statusCode, 200, correctPin.body);
    assert.deepEqual(correctPin.json(), { unlocked: true });

    const wrongPin = await app.inject({
      method: "POST",
      url: `/api/profiles/${pinProfileId}/unlock`,
      headers: phoneA,
      payload: { pin: "1111" },
    });
    assert.equal(wrongPin.statusCode, 403);
    assert.equal(wrongPin.json().error, "invalid_pin");

    const createPendingRequest = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/profiles/switch-requests",
        headers: tvAuthA,
        payload: { profileId: profileA, deviceName: "TV A" },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().status, "pending");
      return response.json().requestId as string;
    };

    const approveId = await createPendingRequest();

    const crossHouseholdRead = await app.inject({
      method: "GET",
      url: `/api/profiles/switch-requests/${approveId}`,
      headers: phoneB,
    });
    assert.equal(crossHouseholdRead.statusCode, 404);

    const crossHouseholdDeny = await app.inject({
      method: "POST",
      url: `/api/profiles/switch-requests/${approveId}/deny`,
      headers: phoneB,
    });
    assert.equal(crossHouseholdDeny.statusCode, 409);

    const crossHouseholdCancel = await app.inject({
      method: "POST",
      url: `/api/profiles/switch-requests/${approveId}/cancel`,
      headers: tvAuthB,
    });
    assert.equal(crossHouseholdCancel.statusCode, 200);

    const stillPending = await app.inject({
      method: "GET",
      url: `/api/profiles/switch-requests/${approveId}`,
      headers: phoneA,
    });
    assert.equal(stillPending.statusCode, 200);
    assert.equal(stillPending.json().status, "pending");

    const approve = await app.inject({
      method: "POST",
      url: `/api/profiles/switch-requests/${approveId}/approve`,
      headers: phoneA,
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.deepEqual(approve.json(), { ok: true, status: "approved" });

    const approvedStatus = await app.inject({
      method: "GET",
      url: `/api/profiles/switch-requests/${approveId}`,
      headers: phoneA,
    });
    assert.equal(approvedStatus.json().status, "approved");

    const denyId = await createPendingRequest();
    const deny = await app.inject({
      method: "POST",
      url: `/api/profiles/switch-requests/${denyId}/deny`,
      headers: phoneA,
    });
    assert.equal(deny.statusCode, 200, deny.body);
    assert.deepEqual(deny.json(), { ok: true, status: "denied" });

    const deniedStatus = await app.inject({
      method: "GET",
      url: `/api/profiles/switch-requests/${denyId}`,
      headers: phoneA,
    });
    assert.equal(deniedStatus.json().status, "denied");

    const cancelId = await createPendingRequest();
    const cancel = await app.inject({
      method: "POST",
      url: `/api/profiles/switch-requests/${cancelId}/cancel`,
      headers: tvAuthA,
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.deepEqual(cancel.json(), { ok: true });

    const cancelledStatus = await app.inject({
      method: "GET",
      url: `/api/profiles/switch-requests/${cancelId}`,
      headers: phoneA,
    });
    assert.equal(cancelledStatus.json().status, "expired");
  } finally {
    await app.close();
    await db.close();
  }
});
