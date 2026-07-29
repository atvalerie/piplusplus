import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTO_CONSECUTIVE_DENIAL_LIMIT,
	AUTO_TOTAL_DENIAL_LIMIT,
	AutoPermissionSession,
	permissionRequestFingerprint,
} from "../extensions/auto-permission.ts";

const request = (command: string) => ({
	agentId: "main",
	agentLabel: "Main agent",
	toolName: "bash",
	input: { command },
});

test("auto mode pauses after three consecutive denials and resumes only after manual approval", () => {
	const session = new AutoPermissionSession();
	for (let index = 1; index < AUTO_CONSECUTIVE_DENIAL_LIMIT; index++) {
		assert.equal(session.recordClassifierDenial(request(`blocked-${index}`), "outside scope").paused, false);
	}
	const pending = request("blocked-3");
	assert.deepEqual(session.recordClassifierDenial(pending, "outside scope"), { paused: true, pauseTriggeredBy: "consecutive" });
	assert.equal(session.promptReason(request("next-action")), "fallback");
	session.resolvePrompt(request("next-action"), "fallback", false);
	assert.equal(session.isPaused(), true);
	session.resolvePrompt(request("next-action"), "fallback", true);
	assert.equal(session.isPaused(), false);
	assert.equal(session.getConsecutiveDenials(), 0);
});

test("an automatic allow resets only the consecutive counter while total denials persist", () => {
	const session = new AutoPermissionSession();
	session.recordClassifierDenial(request("one"), "denied");
	session.recordAutomaticAllow();
	assert.equal(session.getConsecutiveDenials(), 0);
	assert.equal(session.getTotalDenials(), 1);
	for (let index = 1; index < AUTO_TOTAL_DENIAL_LIMIT; index++) {
		session.recordClassifierDenial(request(`denied-${index}`), "denied");
		session.recordAutomaticAllow();
	}
	assert.equal(session.isPaused(), true);
	assert.equal(session.getTotalDenials(), 0, "the total counter resets only when its fallback threshold triggers");
});

test("recent denial retry is fingerprinted deterministically and consumed by one manual prompt", () => {
	const session = new AutoPermissionSession();
	const first = request("git push origin topic");
	const sameWithDifferentKeyOrder = {
		agentLabel: "Main agent",
		agentId: "main",
		input: { command: "git push origin topic" },
		toolName: "bash",
	};
	assert.equal(permissionRequestFingerprint(first), permissionRequestFingerprint(sameWithDifferentKeyOrder));
	session.recordClassifierDenial(first, "Push was not requested");
	const denial = session.getRecentDenials()[0]!;
	session.queueRetry(denial.id);
	assert.equal(session.promptReason(sameWithDifferentKeyOrder), "retry");
	session.resolvePrompt(sameWithDifferentKeyOrder, "retry", false);
	assert.equal(session.promptReason(first), undefined);
});
