// Tests of staging (slice 7b §2): a reload's setups and recorded factories; each kind of throw leaves the host on its
// old code; recorded declarations decide an object's fate.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type FacetHost, type StoreSelf } from "../../../src/next/host/index.ts";
import { defineJob } from "../../../src/next/jobs/index.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { flushed, memoryStore, rejection, Server } from "../support.ts";

const Store = local("app.store", { version: 1, params: {}, members: { label: str(), bump: method(undefined, int()) } });

/** Serves `Store` labelled `label`, its factory running `declare` first. */
function serveStore(label: string, declare: (self: StoreSelf) => void = () => {}) {
	return defineFacet((h: FacetHost) =>
		h.serve(Store, (_, self) => {
			declare(self);
			return { label: constant(label), bump: async () => 0 };
		}),
	);
}

describe("staging: a throw leaves the host on its old code", () => {
	const throwing: [string, ReturnType<typeof serveStore>, string][] = [
		[
			"a setup",
			defineFacet(() => {
				throw new Error("boom");
			}),
			'plugin "@test/app": boom',
		],
		[
			"a factory",
			serveStore("v2", () => {
				throw new Error("boom");
			}),
			'plugin "@test/app", app.store: boom',
		],
		[
			"a declaration error",
			serveStore("v2", (self) => {
				self.state(defineState("d", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
				self.state(defineState("d", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
			}),
			'state "d" is declared twice',
		],
		[
			"a document at an older version than the object's",
			serveStore("v2", (self) =>
				self.state(defineState("doc", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) })),
			),
			"version 1 is older than its documents' (2)",
		],
		[
			"a broken accepts table",
			defineFacet((h) =>
				h.serve(Store, () => ({ label: constant("x"), bump: async () => 0 }), {
					accepts: { 7: {} } as never,
				}),
			),
			"accepts[7]: not an older version",
		],
	];
	for (const [what, facet, message] of throwing) {
		it(`${what}: the reload rejects with it, nothing changed`, async () => {
			const host = createHost({ onError: () => {} });
			const v2 = defineState("doc", {
				schema: obj({ n: int() }),
				version: 2,
				initial: () => ({ n: 0 }),
				migrate: () => ({ n: 0 }),
			});
			await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => self.state(v2)) }], context);
			const store = await host.get(Store, {}, context);
			const error = await rejection(host.reload([{ name: "@test/app", facet }], context));
			expect((error as Error).message).toContain(message);
			expect(store.label.value).toBe("v1");
			expect(store.state.value).toEqual({ kind: "live" });
			// The plugin is still the old one: reloading it with the same facet set again is a change of nothing.
			await host.close(context);
		});
	}

	it("a remote type on a host without an address is refused, as at load", async () => {
		const Remote = remote("app.remote", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: int() } } },
		});
		const host = createHost({ principal: { kind: "server" }, onError: () => {} });
		await host.load([], context);
		const facet = defineFacet((h) => h.serve(Remote, () => ({ variant: "v", members: { n: constant(1) } })));
		expect(await rejection(host.reload([{ name: "@test/app", facet }], context))).toMatchObject({
			message: expect.stringContaining("a host without an address serves only local types"),
		});
		await host.close(context);
	});
});

describe("staging: recorded declarations decide the fate", () => {
	it("records without activating: no native opens, no reference binds, no document is made", async () => {
		const Dep = local("app.dep", { version: 1, params: {}, members: { n: int() } });
		const opened: string[] = [];
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: serveStore("v1") }], context);
		const store = await host.get(Store, {}, context);
		const facet = serveStore("v2", (self) => {
			self.open(
				async () => void opened.push("opened"),
				() => {},
			);
			self.get(Dep, {});
			self.state(defineState("fresh", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
		});
		const report = await host.reload([{ name: "@test/app", facet }], context);
		// It opens natives now: a restart, whose activation opened its native once.
		expect(report.objects).toEqual([{ object: "app.store", kind: "restarted" }]);
		await flushed();
		// Neither staging nor the restart opened it: the new attempt parks on the missing `Dep` first.
		expect(opened).toEqual([]);
		expect(store.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.close(context);
	});

	it("a table of the new factory at a newer version than the store's restarts the object (its eager migration)", async () => {
		const store = await memoryStore();
		const V1 = defineTable("items", { version: 1, columns: { id: str(), name: str() }, key: ["id"] });
		const V2 = evolveTable(V1, (t) => t.rename("name", "title"));
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => self.table(V1)) }], context);
		await host.get(Store, {}, context);
		const same = await host.reload(
			[{ name: "@test/app", facet: serveStore("v2", (self) => self.table(V1)) }],
			context,
		);
		expect(same.objects).toEqual([{ object: "app.store", kind: "swapped" }]);
		const newer = await host.reload(
			[{ name: "@test/app", facet: serveStore("v3", (self) => self.table(V2)) }],
			context,
		);
		expect(newer.objects).toEqual([{ object: "app.store", kind: "restarted" }]);
		await host.close(context);
		await store.close(context);
	});

	it("a job declared at its version with another schema is refused at staging", async () => {
		const Job1 = defineJob("app.job", { version: 1, args: obj({}), result: int() });
		const Job1b = defineJob("app.job", { version: 1, args: obj({ x: int() }), result: int() });
		const host = createHost({ onError: () => {} });
		const run = { run: async () => 1 };
		await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => void self.job(Job1, run)) }], context);
		await host.get(Store, {}, context);
		const facet = serveStore("v2", (self) => void self.job(Job1b, run));
		expect(await rejection(host.reload([{ name: "@test/app", facet }], context))).toMatchObject({
			message: expect.stringContaining("schema changed without a version bump"),
		});
		await host.close(context);
	});

	it("a contribution outside a host-lifetime object is a declaration error at staging", async () => {
		const Names = defineRegistry<string, string[]>("app.names", { version: 1 });
		const Page = local("app.page", { version: 1, params: { id: int() }, members: { id: int() } });
		const host = createHost({ onError: () => {} });
		const page = (contribute: boolean) =>
			defineFacet((h) =>
				h.serve(Page, ({ id }, self) => {
					if (contribute) (self as unknown as StoreSelf).contribute(Names, "x");
					return { id: constant(id) };
				}),
			);
		await host.load([{ name: "@test/app", facet: page(false) }], context);
		await host.get(Page, { id: 1 }, context);
		expect(await rejection(host.reload([{ name: "@test/app", facet: page(true) }], context))).toMatchObject({
			message: expect.stringContaining("self.contribute is valid only in a local type with empty params"),
		});
		await host.close(context);
	});
});

describe("staging: declaration parity with an attempt (fix round 1)", () => {
	it("rejects retryOn of an attempt-owned writable without changing the live host", async () => {
		const T = local("astra.staging", { version: 1, params: {}, members: { n: int() } });
		const oldFacet = defineFacet((h) => h.serve(T, () => ({ n: constant(1) })));
		const newFacet = defineFacet((h) =>
			h.serve(T, (_, self) => {
				self.retryOn(self.writable(0));
				return { n: constant(2) };
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@astra/staging", facet: oldFacet }], context);
		const old = await host.get(T, {}, context);
		let rejected = false;
		try {
			await host.reload([{ name: "@astra/staging", facet: newFacet }], context);
		} catch {
			rejected = true;
		}
		const state = old.state.value;
		old.release();
		await host.close(context);
		expect({ rejected, state: state.kind }).toEqual({ rejected: true, state: "live" });
	});
});
