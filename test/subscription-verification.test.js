"use strict";
// Verification covers HTTP(S) notification URLs and resource IDs other than the Originator.
// The setting remains off by default; enabled deployments require OK from every target.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { is_resource_id_target, is_url_target, verification_targets } = require("../cse/subscription-verification");

test("a protocol-binding URL is not a resource-ID target", () => {
  // coap:// is deliberately absent from this list. The standard names coap as a binding, but
  // mobius4 has none and cse/noti.js does not exclude it, so a coap:// entry is a resource-ID to
  // the code that actually sends notifications. Calling it a URL here would split the two rules.
  // See "the URL rule is the one cse/noti.js applies" below, which pins the whole correspondence.
  for (const url of ["http://host/notify", "https://host/notify", "mqtt://broker/x"]) {
    assert.equal(is_resource_id_target(url), false, url);
  }
});

test("only HTTP(S) URLs use direct verification", () => {
  for (const url of ["http://host/notify", "https://host/notify?key=value"]) {
    assert.equal(is_url_target(url), true, url);
  }
  for (const target of ["mqtt://broker/x", "Mobius/ae1", "httpSink", "http:bad", null, 123]) {
    assert.equal(is_url_target(target), false, String(target));
  }
});

test("a oneM2M resource-ID is a verification target", () => {
  for (const id of ["/CSE1/AE1", "CAE123", "//dom/CSE1/AE1", "Mobius/ae1"]) {
    assert.equal(is_resource_id_target(id), true, id);
  }
});

test("the Originator's own entry is excluded", async () => {
  // The clause says "are not the Originator" -- a subscriber notifying itself has nothing to
  // verify, and asking it to would make the common self-subscription case fail.
  const got = await verification_targets(["/CSE1/AE1", "/CSE1/AE2"], "/CSE1/AE1");
  assert.deepEqual(got, ["/CSE1/AE2"]);
});

test("HTTP(S) URLs join resource-ID targets while the Originator and MQTT are excluded", async () => {
  const got = await verification_targets(
    ["http://h/n", "/CSE1/AE1", "/CSE1/AE2", "mqtt://broker/x", "https://h/n"], "/CSE1/AE1");
  assert.deepEqual(got, ["http://h/n", "/CSE1/AE2", "https://h/n"]);
});

test("URL-only target selection does not need resource lookup", async () => {
  assert.deepEqual(await verification_targets(["http://h/n", "https://h/n"], "Csubscriber"),
    ["http://h/n", "https://h/n"]);
  assert.deepEqual(await verification_targets(["mqtt://broker/x"], "Csubscriber"), []);
  assert.deepEqual(await verification_targets(undefined, "Csubscriber"), []);
});

test("the response status codes are the values the standard assigns", () => {
  // Read from CDT-enumerationTypes.xsd, not from memory. A wrong RSC is silent: the request
  // fails either way and only a conformance tester notices the number.
  const enums = require("../config/enums");
  assert.equal(enums.rsc_str.SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE, 4101);
  assert.equal(enums.rsc_str.SUBSCRIPTION_VERIFICATION_INITIATION_FAILED, 5204);
  assert.equal(enums.rsc_str.SUBSCRIPTION_HOST_HAS_NO_PRIVILEGE, 5205);
});

test("verification is off unless a deployment turns it on", () => {
  const { verification_enabled } = require("../cse/subscription-verification");
  assert.equal(verification_enabled(), false, "config/default.json must ship it disabled");
});

test("SUBSCRIPTION_VERIFICATION=true enables verification without a local configuration file", () => {
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const repoRoot = path.resolve(__dirname, "..");
  const bareConfig = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-verification-config-"));
  fs.copyFileSync(path.join(repoRoot, "config", "default.json"), path.join(bareConfig, "default.json"));
  try {
    for (const [setting, flag, expected] of [
      [false, "true", true], [false, "false", false], [false, "1", false], [false, "", false],
      [true, "false", true],
    ]) {
      const r = spawnSync(process.execPath, ["-e",
        "process.stdout.write(String(require('./cse/subscription-verification').verification_enabled()))"], {
        cwd: repoRoot, encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", NODE_CONFIG_DIR: bareConfig,
          NODE_CONFIG: JSON.stringify({ cse: { subscription_verification: setting } }),
          SUBSCRIPTION_VERIFICATION: flag },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, String(expected), `setting=${setting}, flag=${flag}`);
    }
  } finally {
    fs.rmSync(bareConfig, { recursive: true, force: true });
  }
});

test("the Originator is excluded however it is spelled", async () => {
  // Without this the whole normalisation could be deleted and every other test here would still
  // pass -- each of them writes the Originator and the nu entry as the same string, which plain
  // equality already handles. This is the case that needs it: one AE, the three spellings
  // TS-0001:7.2 defines for it, and a subscription that must not try to verify itself.
  //
  // The spellings are built from the configuration in force rather than written out, because they
  // are not the same on every deployment -- an earlier version of this test hardcoded an SP-ID
  // from one machine's config/local.json and failed anywhere else.
  const config = require("config");
  const { verification_targets } = require("../cse/subscription-verification");
  const cseRelative = `${config.cse.csebase_rn}/ae1`;
  const spellings = [
    cseRelative,
    `${config.cse.cse_id}/${cseRelative}`,
    `${config.cse.sp_id}${config.cse.cse_id}/${cseRelative}`,
  ];
  // A resource on another CSE: it cannot be the Originator and cannot be resolved here, so this
  // test never needs a database. The AE-ID-versus-path case, which does, has its own test below.
  const other = "/CSE9/ae2";
  for (const spelling of spellings) {
    assert.deepEqual(
      await verification_targets([cseRelative, other], spelling), [other],
      `the Originator written as ${spelling} must still be recognised as ${cseRelative}`);
  }
});

test("the module loads without a deployment's own configuration", () => {
  // Not a style point. This module used to reach get_to_info in cse/reqPrim.js, which pulls in the
  // CSE's module graph, and cse/datasetManager.js reads config.get("cse.admin") at load time --
  // an identity config/default.json deliberately does not ship (v4.6.0 removed it so that an
  // operator who never sets one is stopped at startup). Requiring this module therefore threw
  // outright wherever config/local.json was absent: every test here passed on a developer machine
  // and every one of them failed in CI, on a require, before a single assertion ran.
  //
  // Checked in a child process against a configuration directory holding only the shipped
  // default.json, which is what CI actually has.
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const repoRoot = path.resolve(__dirname, "..");
  const bareConfig = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-bare-config-"));
  fs.copyFileSync(path.join(repoRoot, "config", "default.json"), path.join(bareConfig, "default.json"));

  const r = spawnSync(process.execPath, ["-e",
    "const m = require('./cse/subscription-verification');" +
    "m.verification_targets(['/CSE1/AE1', '/CSE1/AE2'], '/CSE1/AE1')" +
    "  .then((r) => process.stdout.write(JSON.stringify(r)));"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_CONFIG_DIR: bareConfig } });

  assert.equal(r.status, 0, `loading the module must not need a deployment identity: ${r.stderr}`);
  assert.equal(r.stdout, JSON.stringify(["/CSE1/AE2"]), "and it must still answer correctly");
});

test("the URL rule is the one cse/noti.js applies, coap included", () => {
  // noti.js sends to an nu entry by poa lookup unless it starts with http or mqtt. coap is not in
  // that list, so a coap:// entry is a resource-ID to noti.js. This module must agree -- treating
  // it as a URL here would mean an entry that gets notified but is never verified.
  const { is_resource_id_target } = require("../cse/subscription-verification");
  const noti_treats_as_url = (nu) => nu.startsWith("http") || nu.startsWith("mqtt");
  for (const nu of ["http://h/n", "https://h/n", "mqtt://b/t", "coap://h/n", "/CSE1/AE1", "CAE123", "Mobius/ae1"]) {
    assert.equal(is_resource_id_target(nu), !noti_treats_as_url(nu), nu);
  }
});

test("an ordinary notification is not treated as a verification request", async () => {
  // The receive path answers 2000 to every NOTIFY today. Whatever this adds must not change
  // that for a normal notification -- every existing subscription depends on it.
  const { handle_verification } = require("../cse/subscription-verification");
  const resp = {};
  const handled = await handle_verification(
    { op: 5, fr: "/CSE1/AE1", to: "Mobius/ae1", pc: { "m2m:sgn": { nev: { rep: {}, net: 3 } } } }, resp);
  assert.equal(handled, false);
  assert.deepEqual(resp, {}, "an untouched response must be left for the normal path");
});

test("a verification request with no creator is refused 4000", async () => {
  // TS-0004:7.5.1.2.3 has the sender set creator to "the Originator ID of the subscription
  // creation request". Without it the receiver has nobody to check, so the request is malformed
  // rather than unauthorised.
  const { handle_verification } = require("../cse/subscription-verification");
  const resp = {};
  const handled = await handle_verification(
    { op: 5, fr: "/CSE1", to: "Mobius/ae1", pc: { "m2m:sgn": { vrq: true } } }, resp);
  assert.equal(handled, true);
  assert.equal(resp.rsc, 4000);
});

test("a NOTIFY that is not a verification request still answers 2000", async () => {
  // The whole receive path, not the module -- what would break a deployment is the wiring,
  // not the predicate.
  const { startServer } = require("./helpers/server");
  const { startSink } = require("./helpers/noti-sink");
  const { ADMIN } = require("./helpers/onem2m");
  const srv = await startServer();
  try {
    const r = await fetch(`${srv.baseUrl}/Mobius`, {
      method: "POST",
      headers: {
        // The default <CSEBase> ACP does not grant NOTIFY (acop bit 16) to 'all' originators --
        // only create/retrieve/update/discovery (db/init.js create_default_acp). An arbitrary
        // unregistered origin gets 4103 here before this task's code is ever reached, which is
        // what "Cverif-probe" from the plan actually measured. Using ADMIN isolates the check
        // to the wiring this task adds.
        "X-M2M-Origin": ADMIN, "X-M2M-RI": "v1", "X-M2M-RVI": "4",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ "m2m:sgn": { nev: { rep: { "m2m:cin": { con: 1 } }, net: 3 }, sur: "x" } }),
    });
    assert.equal(r.headers.get("x-m2m-rsc"), "2000");
  } finally {
    await srv.stop();
  }
});

test("a verification request whose creator and Originator both hold NOTIFY is accepted", async () => {
  // TS-0004:7.5.1.2.3 receiver side: creator and Originator both need NOTIFY privilege to the
  // notificationURI, and then the response is a success. Every other test here reaches a refusal,
  // and a refusal is what a broken privilege check produces too -- so nothing above this line can
  // tell "checked and allowed" from "checked wrongly and denied".
  //
  // That mattered: the check passes a request to access_decision, which fetches the target through
  // retrieve_a_res, which dispatches on to_ty alone. Built without to_ty, the fetch matched no
  // case, left pc unset, and access_decision read that as "no such resource" -- so every
  // verification was refused 4101 however the privileges actually stood. Only the success path
  // shows it.
  //
  // TS-0018에 해당 TP 없음 -- CSE/SUB/NTF/001 and /002 both describe refusals.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, ADMIN, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer();
  try {
    const NOTIFY_BIT = 16;   // acop bit 5, TS-0001:9.6.2
    const RETRIEVE_BIT = 2;  // deliberately not NOTIFY -- the negative case below turns on this
    const allowed = "Cverif-allowed";
    const denied = "Cverif-denied";

    const acpRn = uniqueRn("acp");
    const madeAcp = await create(srv.baseUrl, CSE_BASE, 1, { "m2m:acp": {
      rn: acpRn,
      pv: { acr: [
        { acor: [allowed], acop: NOTIFY_BIT },
        { acor: [denied], acop: RETRIEVE_BIT },
        { acor: [ADMIN], acop: 63 },
      ]},
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    }});
    assert.equal(madeAcp.rsc, "2001", `policy setup failed: ${madeAcp.raw.slice(0, 200)}`);

    // The notification target: a <container> carrying that policy, addressed by resource ID the
    // way a resource-ID notificationURI would be.
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, {
      "m2m:cnt": { rn: cntRn, acpi: [`${CSE_BASE}/${acpRn}`] },
    });
    assert.equal(madeCnt.rsc, "2001", `target setup failed: ${madeCnt.raw.slice(0, 200)}`);

    const verify = async (creator, originator) => {
      const r = await fetch(`${srv.baseUrl}/${CSE_BASE}/${cntRn}`, {
        method: "POST",
        headers: {
          "X-M2M-Origin": originator, "X-M2M-RI": uniqueRn("v"), "X-M2M-RVI": "4",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ "m2m:sgn": { vrq: true, cr: creator } }),
      });
      return r.headers.get("x-m2m-rsc");
    };

    assert.equal(await verify(allowed, allowed), "2000",
      "both parties hold NOTIFY on the target, so the verification succeeds");
    assert.equal(await verify(denied, allowed), "4101",
      "the creator holds RETRIEVE but not NOTIFY");
    assert.equal(await verify(allowed, denied), "5205",
      "the creator is fine; the host sending the request is not -- TS-0004:7.5.1.2.3 names this " +
      "code for it, and it only wins because verification is judged before the generic access " +
      "check, which answered 4103 and left this branch unreachable");
  } finally {
    await srv.stop();
  }
});

// --- send side: verify_targets, wired into <subscription> creation (cse/resources/sub.js) ---

test("verification is skipped entirely when the setting is off", async () => {
  // The default. A URL-only deployment must be untouched, and so must a resource-ID one.
  const { verify_targets } = require("../cse/subscription-verification");
  assert.equal(await verify_targets(["/CSE1/AE1", "http://unreachable.invalid/n"], "/CSE1/AE9"), null);
});

// The four tests below exercise the whole path -- CREATE <subscription> over HTTP, through
// cse/resources/sub.js's call to verify_targets and cse/noti.js's send_verification -- rather
// than the module in isolation. A single test server plays both roles: the CSE under test, and
// (through a local <AE> whose poa points at a sink this file controls) the verification target.
// That is enough to choose what RSC the target answers, which is what these scenarios turn on;
// test/helpers/two-cse.js's two full registered CSEs are not needed for that.

// A local sink whose response X-M2M-RSC is fixed by the caller. test/helpers/noti-sink.js
// always answers 2000 -- it exists to prove notifications *arrive*, not to test the CSE's
// reaction to a target's refusal -- so it cannot exercise "the target refuses verification" on
// its own.
async function startRscSink(rsc, { statusCode = 200, reply = true, tls } = {}) {
  const http = require("node:http");
  const received = [];
  const handler = (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      received.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
      if (!reply) return;
      res.writeHead(statusCode, { ...(rsc === undefined ? {} : { "X-M2M-RSC": String(rsc) }),
        "Content-Type": "application/json" });
      res.end("{}");
    });
  };
  const server = tls ? require("node:https").createServer(tls, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `${tls ? "https" : "http"}://127.0.0.1:${port}/noti`,
    received,
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

// Registers an <AE> with no From (a fresh AE-ID -- the shared ADMIN originator collides with
// 4117 on a second registration) and the given poa list (or none), and returns its resource IDs.
async function aeWithPoa(baseUrl, poa) {
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const rn = uniqueRn("ae");
  const body = poa
    ? { "m2m:ae": { rn, api: "Nsv.verif", rr: true, poa } }
    : { "m2m:ae": { rn, api: "Nsv.verif", rr: false } };
  const res = await create(baseUrl, CSE_BASE, 2, body, { originator: "" });
  assert.equal(res.rsc, "2001", `failed to create the target <AE>: ${res.raw.slice(0, 200)}`);
  return { sid: `${CSE_BASE}/${rn}`, ri: res.body["m2m:ae"].ri };
}

test("regression: with the setting off, a resource-ID nu subscription is created untouched (2001)", async () => {
  // TS-0018에 해당 TP 없음 -- every CRE/NTF TP in this group assumes verification is active; this
  // pins the off default, which is what the plan's Global Constraint ("기존 시험 660건이 계속
  // 통과해야 한다... nu가 URL인 기존 구독 시험은 동작이 바뀌면 안 된다") extends to a resource-ID nu.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer(); // subscription_verification defaults to false
  try {
    // No poa: if the off-switch were wired wrong this would fail to verify and prove the point
    // more sharply than a reachable target would.
    const target = await aeWithPoa(srv.baseUrl, null);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "2001",
      `subscription creation must not be blocked when the setting is off: ${madeSub.raw.slice(0, 200)}`);
  } finally {
    await srv.stop();
  }
});

test("on: the target answers OK, the subscription is created (2001)", async () => {
  // TS-0018에 해당 TP 없음 -- no CRE/NTF TP describes the plain success path separately from an
  // ordinary creation; this pins Recv-6.4 step 5(b)'s "OK" branch.
  const { startServer } = require("./helpers/server");
  const { startSink } = require("./helpers/noti-sink");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const sink = await startSink();
  try {
    const target = await aeWithPoa(srv.baseUrl, [sink.url]);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "2001",
      `verification succeeded but the creation was refused: ${madeSub.raw.slice(0, 200)}`);

    const verif = sink.received.find((i) => i.body?.["m2m:sgn"]?.vrq === true);
    assert.ok(verif, "the sink must have received a verification NOTIFY before the create answered");
    assert.equal(verif.body["m2m:sgn"].cr, "test-admin",
      "creator is the Originator of the subscription creation request (TS-0004:7.5.1.2.3)");
    // TS-0004 table 6.3.5.13-1 gives subscriptionReference multiplicity 1, and
    // CDT-notification.xsd declares it with no minOccurs: it is mandatory on every notification,
    // a verification request included. It was omitted at first because TS-0004:7.5.1.2.3 names
    // only verificationRequest, creator and To -- the procedure clause says what that procedure
    // sets, not what the primitive may leave out, and a receiver validating the data type
    // rejected the notification over it.
    //
    // The value is the ID the <subscription> is about to be given. Verification runs before the
    // insert, so the resource does not exist yet, but its name is already settled.
    assert.equal(verif.body["m2m:sgn"].sur, `${CSE_BASE}/${cntRn}/${subRn}`,
      "sur names the <subscription> this verification is for");

    // TS-0004:7.5.1.2.3 step 1: "Set the To parameter as the notificationURI in the primitive."
    // TS-0009:6.2.2.1 carries To as the request-URI path component, so the path the target sees is
    // the To. It used to be "/" -- the request went to the bare pointOfAccess, which is where to
    // send it and not what it addresses.
    assert.ok(verif.url.endsWith(`/${target.sid}`),
      `To must be the notificationURI: expected a path ending in /${target.sid}, got ${JSON.stringify(verif.url)}`);
  } finally {
    await sink.stop();
    await srv.stop();
  }
});

test("TP/oneM2M/CSE/SUB/CRE/003 on: the target has no reachable pointOfAccess, the creation is " +
  "refused 5204 and no <subscription> is created (TC_ONEM2M_SUB_CRE_03)", async () => {
  const { startServer } = require("./helpers/server");
  const { create, discover, urils, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  try {
    const target = await aeWithPoa(srv.baseUrl, null); // rr:false, no poa -- "cannot be sent"
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);
    const cntSid = `${CSE_BASE}/${cntRn}`;

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, cntSid, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "5204",
      `expected SUBSCRIPTION_VERIFICATION_INITIATION_FAILED: ${madeSub.raw.slice(0, 200)}`);

    // RSC alone does not prove there was no partial creation. Retrieve the parent -- discover()
    // is a RETRIEVE of cntSid with the discovery filter usage -- and confirm the <subscription>
    // is not among its descendants.
    const found = await discover(srv.baseUrl, cntSid);
    assert.deepEqual(urils(found), [], "no <subscription> child may exist after a refused verification");
  } finally {
    await srv.stop();
  }
});

test("on: the target refuses the verification NOTIFY (4103), the creation is refused 5204", async () => {
  // TS-0018에 해당 TP 없음. TP/oneM2M/CSE/SUB/NTF/001 and /002 look adjacent -- a target's Notify
  // response carrying SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE (4101) / SUBSCRIPTION_HOST_HAS_NO_
  // PRIVILEGE (5205) -- but both (TS-0018 v4.6.1, Release 1) have the Hosting CSE propagate that
  // *same* code back to the subscription creator. The current TS-0004:7.4.8.2.1 Recv-6.4 step
  // 5(b) (v5.2.0, read via spec.get_clause during this task) instead fixes the response to
  // SUBSCRIPTION_VERIFICATION_INITIATION_FAILED for *any* non-OK Notify response, regardless of
  // which code it carried. The two disagree, so neither TP is cited here -- the correspondence
  // is not certain, and this task's implementation follows the current clause.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const rscSink = await startRscSink(4103);
  try {
    const target = await aeWithPoa(srv.baseUrl, [rscSink.url]);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "5204",
      `expected SUBSCRIPTION_VERIFICATION_INITIATION_FAILED: ${madeSub.raw.slice(0, 200)}`);
    assert.equal(rscSink.received.length, 1, "the verification NOTIFY must have reached the target");
  } finally {
    await rscSink.stop();
    await srv.stop();
  }
});

for (const viaEnv of [false, true]) {
  test(`an HTTP URL is verified before creation with ${viaEnv ? "the environment flag" : "the configuration setting"}`, async () => {
    const { startServer } = require("./helpers/server");
    const { startSink } = require("./helpers/noti-sink");
    const { create, CSE_BASE, ADMIN, uniqueRn } = require("./helpers/onem2m");
    const config = require("config");
    const previous = process.env.SUBSCRIPTION_VERIFICATION;
    let srv;
    try {
      if (viaEnv) process.env.SUBSCRIPTION_VERIFICATION = "true";
      srv = await startServer({ cse: { subscription_verification: !viaEnv } });
    } finally {
      if (previous === undefined) delete process.env.SUBSCRIPTION_VERIFICATION;
      else process.env.SUBSCRIPTION_VERIFICATION = previous;
    }
    const sink = await startSink();
    try {
      const cntSid = `${CSE_BASE}/${uniqueRn("c")}`;
      const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntSid.split("/").pop() } });
      assert.equal(madeCnt.rsc, "2001", madeCnt.raw);
      const subSid = `${cntSid}/${uniqueRn("s")}`;
      const callbackUrl = `${sink.url}/callback?token=verification`;
      const madeSub = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": {
        rn: subSid.split("/").pop(), et: "20990101T000000", nu: [callbackUrl],
        enc: { net: [3], chty: [4] }, nct: 1,
      } });
      assert.equal(madeSub.rsc, "2001", madeSub.raw);
      assert.deepEqual(madeSub.body["m2m:sub"].nu, [callbackUrl]);
      const verif = sink.received.find((item) => item.body?.["m2m:sgn"]?.vrq === true);
      assert.ok(verif, "verification must arrive before CREATE returns");
      assert.equal(verif.method, "POST");
      assert.equal(verif.url, "/noti/callback?token=verification", "use the URL path and query verbatim");
      assert.deepEqual(verif.body, { "m2m:sgn": { vrq: true, cr: ADMIN, sur: subSid } });
      assert.equal(verif.headers["x-m2m-origin"], config.cse.cse_id);
      assert.equal(verif.headers["x-m2m-rvi"], config.cse.versions[0]);
      assert.match(verif.headers["x-m2m-ri"], /^verif-noti-[A-Za-z0-9._:-]+$/);
      assert.equal(verif.headers["content-type"], "application/json");

      const madeCin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "42" } });
      assert.equal(madeCin.rsc, "2001", madeCin.raw);
      const notification = await sink.waitFor((item) => item.body?.["m2m:sgn"]?.nev?.net === 3);
      assert.equal(notification.body["m2m:sgn"].sur, subSid);
      assert.equal(notification.body["m2m:sgn"].nev.rep["m2m:cin"].ri, madeCin.body["m2m:cin"].ri);
    } finally {
      await sink.stop();
      await srv.stop();
    }
  });
}

test("an HTTPS URL receives verification over a trusted TLS connection", async (t) => {
  const { spawnSync } = require("node:child_process");
  if (spawnSync("openssl", ["version"]).status !== 0) return t.skip("openssl not available");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, ADMIN, uniqueRn } = require("./helpers/onem2m");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-verification-tls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "server.key");
  const cert = path.join(dir, "server.crt");
  const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256",
    "-days", "1", "-nodes", "-keyout", key, "-out", cert,
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const sink = await startRscSink(2000, { tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  t.after(() => sink.stop());
  const previous = process.env.NODE_EXTRA_CA_CERTS;
  let srv;
  try {
    process.env.NODE_EXTRA_CA_CERTS = cert;
    srv = await startServer({ cse: { subscription_verification: true } });
  } finally {
    if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previous;
  }
  t.after(() => srv.stop());
  const cntSid = `${CSE_BASE}/${uniqueRn("c")}`;
  const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntSid.split("/").pop() } });
  assert.equal(madeCnt.rsc, "2001", madeCnt.raw);
  const subSid = `${cntSid}/${uniqueRn("s")}`;
  const madeSub = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": {
    rn: subSid.split("/").pop(), nu: [sink.url], enc: { net: [3] }, nct: 1,
  } });
  assert.equal(madeSub.rsc, "2001", madeSub.raw);
  assert.equal(sink.received.length, 1);
  assert.deepEqual(sink.received[0].body, { "m2m:sgn": { vrq: true, cr: ADMIN, sur: subSid } });
});

test("failed HTTP URL verification refuses creation without persisting a subscription", async (t) => {
  const { startServer, freePort } = require("./helpers/server");
  const { create, retrieve, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true, notification_timeout_seconds: 0.15 } });
  t.after(() => srv.stop());
  const cntSid = `${CSE_BASE}/${uniqueRn("c")}`;
  const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntSid.split("/").pop() } });
  assert.equal(madeCnt.rsc, "2001", madeCnt.raw);
  for (const [name, rsc, options] of [
    ["refusal", 4103, { statusCode: 403 }],
    ["missing response code", undefined, {}],
    ["timeout", 2000, { reply: false }],
    ["connection refused", undefined, null],
  ]) {
    await t.test(name, async () => {
      const sink = options ? await startRscSink(rsc, options) : null;
      try {
        const url = sink ? sink.url : `http://127.0.0.1:${await freePort()}/noti`;
        const subSid = `${cntSid}/${uniqueRn("s")}`;
        const madeSub = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": {
          rn: subSid.split("/").pop(), nu: [url], enc: { net: [3] }, nct: 1,
        } });
        assert.equal(madeSub.rsc, "5204", madeSub.raw);
        assert.equal((await retrieve(srv.baseUrl, subSid)).rsc, "4004",
          "a failed verification must leave no subscription");
        if (sink) assert.equal(sink.received.length, 1);
      } finally {
        if (sink) await sink.stop();
      }
    });
  }
});

test("every target in a mixed URL and resource-ID subscription must verify successfully", async () => {
  const { startServer } = require("./helpers/server");
  const { create, retrieve, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const accepted = await startRscSink(2000);
  const refused = await startRscSink(4103);
  try {
    const target = await aeWithPoa(srv.baseUrl, [accepted.url]);
    const cntSid = `${CSE_BASE}/${uniqueRn("c")}`;
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntSid.split("/").pop() } });
    assert.equal(madeCnt.rsc, "2001", madeCnt.raw);
    const subSid = `${cntSid}/${uniqueRn("s")}`;
    const madeSub = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": {
      rn: subSid.split("/").pop(), nu: [accepted.url, target.sid, refused.url], enc: { net: [3] }, nct: 1,
    } });
    assert.equal(madeSub.rsc, "5204", madeSub.raw);
    assert.equal(accepted.received.length, 2, "both direct URL and resource-ID targets are contacted");
    assert.equal(refused.received.length, 1);
    assert.equal((await retrieve(srv.baseUrl, subSid)).rsc, "4004");
  } finally {
    await accepted.stop();
    await refused.stop();
    await srv.stop();
  }
});

test("HTTP URL subscriptions skip verification when the setting is off", async () => {
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: false } });
  const sink = await startRscSink(4103);
  try {
    const cntSid = `${CSE_BASE}/${uniqueRn("c")}`;
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntSid.split("/").pop() } });
    assert.equal(madeCnt.rsc, "2001", madeCnt.raw);
    const madeSub = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": {
      rn: uniqueRn("s"), nu: [sink.url], enc: { net: [3] }, nct: 1,
    } });
    assert.equal(madeSub.rsc, "2001", madeSub.raw);
    assert.equal(sink.received.length, 0, "the disabled feature must not contact the target");
  } finally {
    await sink.stop();
    await srv.stop();
  }
});

test("a subscriber that names itself by path is not asked to verify its own subscription", async () => {
  // TS-0004:7.4.8.2.1 Recv-6.4 verifies notificationURI entries that "are not the Originator". One
  // <AE> answers to two names: it registers and is thereafter the Originator by its AE-ID
  // ("C3tXgC"), while a notificationURI pointing at it is written as a path ("Mobius/ae1"). Those
  // are not equal as strings, so comparing names as text sends the subscriber a verification
  // request for the subscription it is in the middle of creating.
  //
  // Requires a database, unlike the other target-selection tests here, because that is the whole
  // point: telling the two names apart is a lookup, not string work. It is also the only case that
  // pays for one -- names that already match as text are settled without a query.
  //
  // TS-0018에 해당 TP 없음.
  const { startServer } = require("./helpers/server");
  const { startSink } = require("./helpers/noti-sink");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const sink = await startSink();
  try {
    // The <AE> is reachable, so a verification request WOULD arrive at the sink if one were sent.
    // That is what makes the assertion below meaningful: the subscription succeeding proves
    // nothing on its own, since the sink answers 2000 and verification would have passed anyway.
    const rn = uniqueRn("ae");
    const madeAe = await create(srv.baseUrl, CSE_BASE, 2,
      { "m2m:ae": { rn, api: "Nsv.self", rr: true, poa: [sink.url] } }, { originator: "" });
    assert.equal(madeAe.rsc, "2001", `failed to register the <AE>: ${madeAe.raw.slice(0, 200)}`);
    const aei = madeAe.body["m2m:ae"].aei;
    assert.ok(aei, "the CSE must have assigned an AE-ID");
    assert.notEqual(aei, `${CSE_BASE}/${rn}`, "the two names must differ, or this test proves nothing");

    const cntRn = uniqueRn("c");
    await create(srv.baseUrl, `${CSE_BASE}/${rn}`, 3, { "m2m:cnt": { rn: cntRn } }, { originator: aei });

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${rn}/${cntRn}`, 23, {
      // The AE subscribes and points the notification at itself, by path.
      "m2m:sub": { rn: subRn, nu: [`${CSE_BASE}/${rn}`], enc: { net: [3] }, nct: 1 },
    }, { originator: aei });
    assert.equal(madeSub.rsc, "2001", `the creation must succeed: ${madeSub.raw.slice(0, 200)}`);

    const verif = sink.received.find((i) => i.body?.["m2m:sgn"]?.vrq === true);
    assert.equal(verif, undefined,
      `the Originator must not be sent a verification request for its own subscription; ` +
      `the sink received ${JSON.stringify(sink.received.map((i) => i.body))}`);
  } finally {
    await sink.stop();
    await srv.stop();
  }
});
