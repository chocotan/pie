// Staging (slice 7b §2): a plugin set's setups run into a staged table beside the live one (the types it serves with
// their providers, the registries it serves, its facet contributions by plugin) with `load`'s checks; and an object's
// new factory run against a recording `self`, which keeps what the factory declares (natives, documents, tables, jobs,
// contributions, requests) and activates, binds and opens nothing, so a reload decides each object's fate before its
// commit. `load` stages its facets the same way and publishes them.

import type { Context } from "../../context/index.ts";
import type { Watchable } from "../../watch.ts";
import type { Contract } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import type { Principal } from "../data/index.ts";
import { bindProvider, checkParams } from "../data/internal.ts";
import type { AnyDefinition } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import type { Registry, RegistryProvider } from "../registries/index.ts";
import { checkProvider, type RegistryValueSource } from "../registries/internal.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import type { StoreSelf } from "./attempt.ts";
import { type Facet, type FacetContribution, type ServedEntry, setUp } from "./facet.ts";
import type { ChordObject, LocalContract, RemoteContract, Served } from "./object.ts";
import type { Presence } from "./presence.ts";
import { retrySource } from "./retry-on.ts";

/** A plugin's facet as `load` and `reload` take it: its name (its `package.json` name) and its facet. */
export type PluginFacet<P extends Principal = Principal> = { readonly name: string; readonly facet: Facet<P> };

/** A registry a staged plugin serves: the defining plugin, the token and its provider. */
export type StagedRegistry = {
	readonly plugin: string;
	readonly registry: Registry<unknown, unknown>;
	readonly provider: RegistryProvider<unknown, unknown>;
};

/** A plugin set's setups, run and checked: what it serves and contributes, nothing published yet. */
export type Staged = {
	/** The served types by name, each with its plugin, factory, provider (its `accepts` checked) and `linger`. */
	readonly types: Map<string, Served>;
	/** The served registries by name. */
	readonly registries: Map<string, StagedRegistry>;
	/** The facet contributions by plugin, in each setup's order. */
	readonly contributions: Map<string, readonly FacetContribution[]>;
};

/** What staging needs of its host: whom it acts as, where it lives, and its presence lists for setups. */
export type StagingHost = {
	readonly principal: Principal | undefined;
	readonly address: unknown;
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, Principal>[]>;
};

/** An npm package name, scoped or not. */
const PLUGIN_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/**
 * Runs every facet's setup and checks what they declared: plugin names (npm names, each once), a type or registry
 * served twice, a remote type on a host without a principal or address, every provider's `accepts` (`checkAccepts`)
 * and every registry provider's shape. Throws the first error (naming its plugin where the check does not).
 */
export function stagePlugins<P extends Principal>(facets: readonly PluginFacet<P>[], host: StagingHost): Staged {
	const staged: Staged = { types: new Map(), registries: new Map(), contributions: new Map() };
	for (const { name, facet } of facets) {
		if (!PLUGIN_NAME.test(name)) throw new Error(`"${name}" is not a valid plugin name`);
		if (staged.contributions.has(name)) throw new Error(`plugin "${name}" is loaded twice`);
		// The host's presence lists are typed for its `P`.
		const references = host.references as <C extends Contract>(Type: C) => Watchable<readonly Presence<C, P>[]>;
		let setup: ReturnType<typeof setUp<P>>;
		try {
			setup = setUp(name, facet, references);
		} catch (error) {
			throw named(error, `plugin "${name}"`);
		}
		const { served, contributions } = setup;
		for (const entry of served) stageEntry(name, entry, staged, host);
		staged.contributions.set(name, contributions);
	}
	return staged;
}

/** Stages one served entry of `plugin`: a registry's provider, or a type as `Served`. */
function stageEntry(plugin: string, entry: ServedEntry, staged: Staged, host: StagingHost): void {
	if (entry.kind === "registry") {
		const { registry, provider } = entry;
		if (staged.registries.has(registry.name)) throw new Error(`registry ${registry.name} is served twice`);
		checkProvider(registry.name, provider);
		staged.registries.set(registry.name, { plugin, registry, provider });
		return;
	}
	const { contract, factory, options } = entry;
	if (staged.types.has(contract.name)) throw new Error(`${contract.name} is served twice`);
	// A client serves only local types (§3): a remote object is owned by a principal of the host serving it.
	if (contract.kind === "remote" && host.principal === undefined) {
		throw new Error(`${contract.name}: a host without a principal serves only local types`);
	}
	// A remote object lives on the host its `hostAddress` names: only a host with an address can be that host.
	if (contract.kind === "remote" && host.address === undefined) {
		throw new Error(`${contract.name}: a host without an address serves only local types`);
	}
	const provider = bindProvider(contract, options.accepts ?? {});
	const common = { plugin, provider, linger: options.linger ?? 0 };
	// The contract's kind decides the factory's signature and the contract's shape.
	const served: Served =
		contract.kind === "local"
			? {
					...common,
					kind: "local",
					contract: contract as LocalContract,
					factory: factory as Extract<Served, { kind: "local" }>["factory"],
					hostLifetime: contractData(contract).params.fields.length === 0,
				}
			: {
					...common,
					kind: "remote",
					contract: contract as RemoteContract,
					factory: factory as Extract<Served, { kind: "remote" }>["factory"],
				};
	staged.types.set(contract.name, served);
}

/** What a recorded factory declared: what a reload's fate and checks need, nothing activated. */
export type Recorded = {
	/** How many natives it opens (`self.open`). */
	readonly natives: number;
	readonly documents: readonly AnyDefinition[];
	readonly tables: readonly TableDefinition[];
	readonly jobs: readonly JobDefinition<unknown, unknown, unknown>[];
	readonly contributions: readonly Registry<unknown, unknown>[];
	/** Its requests: the types it gets (`self.get`) and the registries it reads (`self.registry`), by name. */
	readonly requests: readonly string[];
};

/**
 * Runs `served`'s factory for `object` (its params and principal) against a recording `self` and returns what it
 * declared. Every declaration check an attempt makes runs, without effects (declared twice; persisted data in a type
 * without a stable identity, on a host without a store, or claimed by another owner; contributions outside
 * host-lifetime objects, or twice; `retryOn` sources that do not outlive the attempt; params; a document or job
 * declared at an older version than the object's, or at its version with another schema); a throw is the factory's.
 * Handles it hands out are inert, except registry values (the host's own, which `retryOn` checks by kind).
 */
export function recordFactory(object: ChordObject, served: Served, context: Context): Recorded {
	const recording = new RecordingSelf(object, served, context);
	// A recording `self` takes every declaration a factory makes, its handles inert.
	const self = recording as unknown as StoreSelf;
	try {
		if (served.kind === "local") served.factory(object.params, self);
		// A remote object's identity has its principal.
		else served.factory(object.params, object.principal!, self);
	} catch (error) {
		throw named(error, `plugin "${served.plugin}", ${object.label}`);
	} finally {
		recording.declaring = false;
	}
	return recording.recorded;
}

/** A staging error naming where it happened (`what`): its message prefixed, the error itself its cause. */
function named(error: unknown, what: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${what}: ${message}`, { cause: error });
}

/**
 * The value of every handle a recording `self` hands out: any property or call gives it again, and it is never a
 * thenable. Typed `never` (a cast: it stands for every handle type, and nothing reads it as one).
 */
const INERT: never = new Proxy(() => {}, {
	get: (_target, property) => (property === "then" ? undefined : INERT),
	apply: () => INERT,
}) as never;

/** A factory's `self` during staging: it records declarations and checks them; it activates nothing. */
class RecordingSelf {
	declaring = true;
	readonly #object: ChordObject;
	readonly #served: Served;
	readonly #context: Context;
	#natives = 0;
	readonly #documents = new Map<string, AnyDefinition>();
	readonly #tables = new Map<string, TableDefinition>();
	readonly #jobs = new Map<string, JobDefinition<unknown, unknown, unknown>>();
	readonly #contributions = new Map<string, Registry<unknown, unknown>>();
	readonly #requests: string[] = [];

	constructor(object: ChordObject, served: Served, context: Context) {
		this.#object = object;
		this.#served = served;
		this.#context = context;
	}

	get recorded(): Recorded {
		return {
			natives: this.#natives,
			documents: [...this.#documents.values()],
			tables: [...this.#tables.values()],
			jobs: [...this.#jobs.values()],
			contributions: [...this.#contributions.values()],
			requests: this.#requests,
		};
	}

	state(definition: AnyDefinition): never {
		this.#assertDeclaring("state");
		const what = `state "${definition.name}"`;
		if (this.#documents.has(definition.name)) throw new Error(`${this.#object.label}: ${what} is declared twice`);
		if (definition.persist) this.#assertClaimable(what, ["chord"]);
		this.#object.documents.check(definition);
		this.#documents.set(definition.name, definition);
		return INERT;
	}

	table(definition: TableDefinition): never {
		this.#assertDeclaring("table");
		const store = this.#assertPersistable(`table "${definition.name}"`);
		if (this.#tables.has(definition.name)) {
			throw new Error(`${this.#object.label}: table "${definition.name}" is declared twice`);
		}
		const object = this.#object;
		store.claims.assertTable(tableSqlName(object.served.contract.name, definition.name), object);
		this.#tables.set(definition.name, definition);
		return INERT;
	}

	derive(): never {
		this.#assertDeclaring("derive");
		return INERT;
	}

	get(Type: Contract, params: unknown): never {
		this.#assertDeclaring("get");
		checkParams(Type, params, this.#context);
		this.#requests.push(Type.name);
		return INERT;
	}

	registry(R: Registry<unknown, unknown>): RegistryValueSource {
		this.#assertDeclaring("registry");
		this.#requests.push(R.name);
		// The host's own value (an attempt declares the same one): `retryOn` checks its kind.
		return this.#object.host.registryRecord(R.name).value(R.version);
	}

	writable(): never {
		this.#assertDeclaring("writable");
		return INERT;
	}

	retryOn(...sources: readonly unknown[]): void {
		this.#assertDeclaring("retryOn");
		for (const source of sources) retrySource(source, this.#object.label);
	}

	contribute(R: Registry<unknown, unknown>): void {
		this.#assertDeclaring("contribute");
		const served = this.#served;
		const { label } = this.#object;
		// R21: plugin code is bundled without type checks.
		if (served.kind !== "local" || !served.hostLifetime) {
			throw new Error(`${label}: self.contribute is valid only in a local type with empty params`);
		}
		if (this.#contributions.has(R.name)) throw new Error(`${label}: registry ${R.name} is contributed to twice`);
		this.#contributions.set(R.name, R);
	}

	open(): never {
		this.#assertDeclaring("open");
		this.#natives++;
		return INERT;
	}

	tx(): never {
		throw new Error(`${this.#object.label}: self.tx runs in calls, not in a factory`);
	}

	follow(): never {
		this.#assertDeclaring("follow");
		return INERT;
	}

	on(): void {
		this.#assertDeclaring("on");
	}

	onLive(): void {
		this.#assertDeclaring("onLive");
	}

	job(definition: JobDefinition<unknown, unknown, unknown>): never {
		this.#assertDeclaring("job");
		const object = this.#object;
		if (this.#jobs.has(definition.name))
			throw new Error(`${object.label}: job "${definition.name}" is declared twice`);
		if (definition.persist !== undefined) {
			this.#assertClaimable(`job "${definition.name}"`, ["chord.jobs", "chord.job-states"]);
		}
		object.checkJob(definition);
		this.#jobs.set(definition.name, definition);
		return INERT;
	}

	/** Persisted data needs a stable identity (P3) and the host's store, as an attempt checks; returns the store. */
	#assertPersistable(what: string): ChordStore {
		const served = this.#served;
		const { host, label } = this.#object;
		if (served.kind !== "local" || contractData(served.contract).params.fields.length > 0) {
			throw new Error(`${label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		}
		if (host.store === undefined) throw new Error(`${label}: ${what}: persist needs a store`);
		return host.store;
	}

	/** Persisted documents in `namespaces`: as `#assertPersistable`, and not claimed by another owner. */
	#assertClaimable(what: string, namespaces: readonly string[]): void {
		const store = this.#assertPersistable(what);
		const object = this.#object;
		for (const namespace of namespaces) store.claims.assertDocuments(object.served.contract.name, namespace, object);
	}

	#assertDeclaring(declaration: string): void {
		if (!this.declaring) throw new Error(`${this.#object.label}: self.${declaration} is valid only in the factory`);
	}
}

/**
 * Whether `recorded`'s tables are at a version newer than `object`'s store has them: their eager migration runs at an
 * activation, so the object restarts instead of swapping (§4).
 */
export function migratesTables(object: ChordObject, recorded: Recorded): boolean {
	const { store } = object.host;
	if (store === undefined) return false;
	const owner = object.served.contract.name;
	return recorded.tables.some((table) => {
		const stored = store.table(tableSqlName(owner, table.name));
		return stored !== undefined && stored.version < table.version;
	});
}
