import { strict as assert } from "assert"
import sqlite from "better-sqlite3"
import * as fs from "fs-extra"
import level from "level"
import { after, describe, it } from "mocha"
import { ConcurrencyLog } from "../database/ConcurrencyLog"
import { ReactivityTracker } from "../database/sync/ReactivityTracker"
import { Assert, SchemaSubspace } from "../database/typeHelpers"
import { binarySearch } from "../helpers/binarySearch"
import { encodeTuple } from "../helpers/codec"
import { compare } from "../helpers/compare"
import { compareTuple } from "../helpers/compareTuple"
import { scan } from "../helpers/sortedTupleArray"
import {
	AsyncTupleDatabaseClient,
	namedTupleToObject,
	ReadOnlyTupleDatabaseClientApi,
	subscribeQuery,
	transactionalAsyncQuery,
	transactionalQuery,
	TupleDatabase,
	TupleDatabaseClient,
} from "../main"
import { InMemoryTupleStorage } from "../storage/InMemoryTupleStorage"
import { LevelTupleStorage } from "../storage/LevelTupleStorage"
import { SQLiteTupleStorage } from "../storage/SQLiteTupleStorage"
import { MAX, Writes } from "../storage/types"

describe.only("talk", () => {
	describe("tuple sorting", () => {
		const items = [
			["jonathan", "smith"],
			["chet", "corcos"],
			["jon", "smith"],
		]

		it("compares tuples element-wise", () => {
			const sorted = [...items].sort(compareTuple)
			assert.deepEqual(sorted, [
				["chet", "corcos"],
				["jon", "smith"],
				["jonathan", "smith"],
			])
		})

		it("doesn't concat the elements", () => {
			const joined = [...items].map((tuple) => tuple.join(""))
			joined.sort(compare)

			assert.deepEqual(joined, [
				"chetcorcos",
				"jonathansmith", // changed order!
				"jonsmith",
			])
		})

		it("can be encoded into bytes while preserving order", () => {
			const encoded = items.map((tuple) => tuple.join("\x00"))
			encoded.sort(compare)
			assert.deepEqual(encoded, [
				"chet\x00corcos",
				"jon\x00smith",
				"jonathan\x00smith",
			])
		})

		it("numbers can't just be stringified", () => {
			const encoded = [1, 2, 11, 12, 100].map((n) => n.toString())
			encoded.sort(compare)
			assert.deepEqual(encoded, ["1", "100", "11", "12", "2"])
		})

		it("can encode other kinds of values", () => {
			const encoded = [[1], ["hello", "world"], [true]].map(encodeTuple)
			encoded.sort(compare)

			// numbers > arrays > boolean
			assert.deepEqual(encoded, [
				"e>;;410230\x00",
				"fhello\x00fworld\x00",
				"gtrue\x00",
			])
		})

		// A take-home exercise.
		it.skip("properly escapes \x00 bytes")
	})

	describe("binary search", () => {
		const items = [0, 1, 2, 3, 4, 5]
		it("find before", () => {
			const result = binarySearch(items, -1, compare)
			assert.deepEqual(result, { closest: 0 })

			// insert
			const newItems = [...items]
			newItems.splice(result.closest, 0, -1)
			assert.deepEqual(newItems, [-1, 0, 1, 2, 3, 4, 5])
		})
		it("find after", () => {
			const result = binarySearch(items, 10, compare)
			assert.deepEqual(result, { closest: 6 })

			// insert
			const newItems = [...items]
			newItems.splice(result.closest, 0, 10)
			assert.deepEqual(newItems, [0, 1, 2, 3, 4, 5, 10])
		})
		it("find middle", () => {
			const result = binarySearch(items, 1.5, compare)
			assert.deepEqual(result, { closest: 2 })

			// insert
			const newItems = [...items]
			newItems.splice(result.closest, 0, 1.5)
			assert.deepEqual(newItems, [0, 1, 1.5, 2, 3, 4, 5])
		})
		it("find exact", () => {
			const result = binarySearch(items, 5, compare)
			assert.deepEqual(result, { found: 5 })

			// delete
			const newItems = [...items]
			newItems.splice(result.found, 1)
			assert.deepEqual(newItems, [0, 1, 2, 3, 4])
		})
	})

	describe("scan", () => {
		const items = [
			["chet", "corcos"],
			["charlotte", "whitney"],
			["joe", "stevens"],
			["jon", "smith"],
			["jonathan", "smith"],
			["zoe", "brown"],
		].sort(compareTuple)

		it("works", () => {
			const result = scan(items, { gte: ["j"], lt: ["k"] })
			assert.deepEqual(result, [
				["joe", "stevens"],
				["jon", "smith"],
				["jonathan", "smith"],
			])
		})
	})

	describe("tuple-value pairs", () => {
		const pairs: { key: string[]; value?: number }[] = [
			{ key: ["chet", "corcos"], value: 0 },
			{ key: ["jon", "smith"], value: 2 },
			{ key: ["jonathan", "smith"], value: 1 },
		]

		it("works", () => {
			const result = binarySearch(pairs, { key: ["jon", "smith"] }, (a, b) => {
				return compareTuple(a.key, b.key)
			})
			assert.deepEqual(result, { found: 1 })
		})
	})

	describe("TupleStorageApi", () => {
		it("works", () => {
			const storage = new InMemoryTupleStorage()

			storage.commit({
				set: [
					{ key: ["chet", "corcos"], value: 0 },
					{ key: ["jon", "smith"], value: 2 },
					{ key: ["jonathan", "smith"], value: 1 },
				],
			})

			const result = storage.scan({ gte: ["j"], lt: ["k"] })

			assert.deepEqual(result, [
				{ key: ["jon", "smith"], value: 2 },
				{ key: ["jonathan", "smith"], value: 1 },
			])
		})

		fs.mkdirpSync(__dirname + "/../tmp")

		it("SQLite Storage", () => {
			const filePath = __dirname + "/../tmp/sqlite.db"
			const storage = new SQLiteTupleStorage(sqlite(filePath))

			storage.commit({
				set: [
					{ key: ["chet", "corcos"], value: 0 },
					{ key: ["jon", "smith"], value: 2 },
					{ key: ["jonathan", "smith"], value: 1 },
				],
			})

			const result = storage.scan({ gte: ["j"], lt: ["k"] })

			assert.deepEqual(result, [
				{ key: ["jon", "smith"], value: 2 },
				{ key: ["jonathan", "smith"], value: 1 },
			])
		})

		it("LevelDb Storage", async () => {
			const filePath = __dirname + "/../tmp/level.db"
			const storage = new LevelTupleStorage(level(filePath))

			await storage.commit({
				set: [
					{ key: ["chet", "corcos"], value: 0 },
					{ key: ["jon", "smith"], value: 2 },
					{ key: ["jonathan", "smith"], value: 1 },
				],
			})

			const result = await storage.scan({ gte: ["j"], lt: ["k"] })

			assert.deepEqual(result, [
				{ key: ["jon", "smith"], value: 2 },
				{ key: ["jonathan", "smith"], value: 1 },
			])
		})
	})

	describe("TupleDatabase", () => {
		it("reactivity", () => {
			const db = new TupleDatabase(new InMemoryTupleStorage())

			let writes: Writes | undefined
			const unsubscribe = db.subscribe(
				{ gt: ["score"], lte: ["score", MAX] },
				(w) => {
					writes = w
				}
			)
			after(unsubscribe)

			db.commit({ set: [{ key: ["score", "chet"], value: 2 }] })
			assert.deepEqual(writes, {
				set: [{ key: ["score", "chet"], value: 2 }],
				remove: [],
			})
		})

		it("transactional", () => {
			const db = new TupleDatabase(new InMemoryTupleStorage())

			db.commit({
				set: [
					{ key: ["score", "chet"], value: 2 },
					{ key: ["score", "meghan"], value: 1 },
				],
			})

			const chet = "tx1"
			const meghan = "tx2"

			// Meghan reads all the scores
			const items = db.scan({ gt: ["score"], lte: ["score", MAX] }, meghan)
			const total = items.map(({ value }) => value).reduce((a, b) => a + b, 0)

			// Chet writes a new score
			db.commit({ set: [{ key: ["score", "chet"], value: 5 }] }, chet)

			// Meghan writes the total
			assert.throws(() => {
				db.commit({ set: [{ key: ["total"], value: total }] }, meghan)
			})
		})
	})

	describe("Reactivity", () => {
		it("works", () => {
			const reactivity = new ReactivityTracker()

			const unsubscribe = reactivity.subscribe(
				{ gt: ["score"], lte: ["score", MAX] },
				(writes) => {}
			)

			// Listen on a tuple prefix, include bounds for checking after.
			//
			// console.log(reactivity.listenersDb.scan())
			// [
			// 	{
			// 		key: [["score"], "bb1beaa2-dd87-440e-b74f-95f307129e2b"],
			// 		value: {
			// 			callback: (writes) => {},
			// 			bounds: { gt: ["score"], lte: ["score", MAX] },
			// 		},
			// 	},
			// ]

			const emits = reactivity.computeReactivityEmits({
				set: [{ key: ["score", "chet"], value: 10 }],
			})
			// Look for listeners at any prefix: ["score", "chet"], ["score"], and []
			//
			// console.log(emits)
			// Map {
			// 	 [(writes) => {}] => { set: [ { key: ["score", "chet"], value: 10 } ] }
			// }
		})
	})

	describe("Concurrency control", () => {
		it("Only records writes with conflicting reads.", () => {
			const log = new ConcurrencyLog()

			// Someone reads all the scores and updates the total
			log.read("tx1", { gt: ["score"], lte: ["score", MAX] })
			log.write("tx1", ["total"])

			// At the same time, someone writes a score.
			log.write("tx2", ["score", "chet"])

			// Keeping track of concurrent reads/writes.
			assert.deepEqual(log.log, [
				{
					txId: "tx1",
					type: "read",
					bounds: {
						gt: ["score"],
						lte: ["score", MAX],
					},
				},
				{
					txId: "tx2",
					type: "write",
					tuple: ["score", "chet"],
				},
			])

			log.commit("tx2")
			assert.throws(() => log.commit("tx1"))
		})
	})

	describe("Database client", () => {
		it("has schema types", () => {
			type Schema =
				| { key: ["score", string]; value: number }
				| { key: ["total"]; value: number }

			const db = new TupleDatabaseClient<Schema>(
				new TupleDatabase(new InMemoryTupleStorage())
			)

			// Convenient "prefix" argument.
			const scores = db.scan({ prefix: ["score"] }).map(({ value }) => value)
			type WellTyped = Assert<typeof scores, number[]>
		})

		it("has subspaces", () => {
			type GameSchema =
				| { key: ["score", string]; value: number }
				| { key: ["total"]; value: number }

			type Schema =
				| { key: ["games", string]; value: null }
				| SchemaSubspace<["game", string], GameSchema>

			const db = new TupleDatabaseClient<Schema>(
				new TupleDatabase(new InMemoryTupleStorage())
			)

			// Get a list of games.
			const gameIds = db.scan({ prefix: ["games"] }).map(({ key }) => key[1])

			// Narrow in on a specific game.
			const gameId: string = "game1"
			const gameDb = db.subspace(["game", gameId])

			// Get is also a convenience that uses prefix and returns the first value.
			const total = gameDb.get(["total"])
			type WellTyped = Assert<typeof total, number | undefined>
		})

		// Useful for multiple windows, for example.
		it("works across processes", async () => {
			const db = new TupleDatabase(new InMemoryTupleStorage())

			const db2 = new AsyncTupleDatabaseClient({
				scan: async (...args) => db.scan(...args),
				commit: async (...args) => db.commit(...args),
				cancel: async (...args) => db.cancel(...args),
				close: async (...args) => db.close(...args),
				// Note: this requires a socket, not just RPC.
				subscribe: async (args, callback) => db.subscribe(args, callback),
			})

			db.commit({ set: [{ key: ["a"], value: 1 }] })
			assert.equal(await db2.get(["a"]), 1)
		})

		it("transaction conveniences", async () => {
			type Schema =
				| { key: ["score", string]; value: number }
				| { key: ["total"]; value: number }

			const db = new AsyncTupleDatabaseClient<Schema>(
				new TupleDatabase(new InMemoryTupleStorage())
			)

			example1: {
				const tx = db.transact()
				tx.set(["score", "chet"], 1)
				tx.set(["score", "meghan"], 2)
				tx.set(["total"], 3)
				await tx.commit()
			}

			example2: {
				const tx = db.transact()
				tx.set(["score", "chet"], 2)
				tx.set(["total"], 4)
				// Reading through a transaction will return an updates result.
				assert.equal(await tx.get(["total"]), 4)
				tx.cancel()
			}

			example3: {
				const updateTotal = transactionalAsyncQuery<Schema>()(async (tx) => {
					const result = await tx.scan({ prefix: ["score"] })
					const total = result
						.map(({ value }) => value)
						.reduce((a, b) => a + b, 0)
					tx.set(["total"], total)
				})

				const setScore = transactionalAsyncQuery<Schema>()(
					async (tx, person: string, score: number) => {
						tx.set(["score", person], score)
						await updateTotal(tx)
					}
				)

				await setScore(db, "joe", 15)

				assert.deepEqual(await db.scan(), [
					{ key: ["score", "chet"], value: 1 },
					{ key: ["score", "joe"], value: 15 },
					{ key: ["score", "meghan"], value: 2 },
					{ key: ["total"], value: 18 },
				])
			}
		})
	})

	describe("Example", () => {
		it("example 1", () => {
			// many-to-many relationships
			// indexing queries, across joins
			// reactivity.

			type Page = { id: string; tags: string[]; content: string }
			type Tag = { id: string; title: string }

			type Schema =
				| { key: ["page", { pageId: string }]; value: Page }
				| { key: ["tag", { tagId: string }]; value: Tag }
				| {
						key: ["pagesByTag", { tagId: string }, { pageId: string }]
						value: null
				  }
				| {
						key: ["tagsByPage", { pageId: string }, { tagId: string }]
						value: null
				  }
				| {
						key: ["tagsByTitle", { title: string }, { tagId: string }]
						value: null
				  }

			const db = new TupleDatabaseClient<Schema>(
				new TupleDatabase(new InMemoryTupleStorage())
			)

			const indexPage = transactionalQuery<Schema>()((tx, page: Page) => {
				// Remove existing tags from the index.
				const pageId = page.id
				const tagIds = tx
					.scan({ prefix: ["tagsByPage", { pageId }] })
					.map(({ key }) => namedTupleToObject(key))
					.map(({ tagId }) => tagId)

				tagIds.forEach((tagId) => {
					tx.remove(["pagesByTag", { tagId }, { pageId }])
					tx.remove(["tagsByPage", { pageId }, { tagId }])
				})

				// Write new tags.
				page.tags.forEach((tagId) => {
					tx.set(["pagesByTag", { tagId }, { pageId }], null)
					tx.set(["tagsByPage", { pageId }, { tagId }], null)
				})
			})

			const writePage = transactionalQuery<Schema>()((tx, page: Page) => {
				tx.set(["page", { pageId: page.id }], page)
				indexPage(tx, page)
			})

			const writeTag = transactionalQuery<Schema>()((tx, tag: Tag) => {
				const tagId = tag.id
				const existingTag = tx.get(["tag", { tagId }])
				if (existingTag && existingTag.title !== tag.title) {
					tx.remove(["tagsByTitle", { title: existingTag.title }, { tagId }])
				}

				tx.set(["tag", { tagId }], tag)
				tx.set(["tagsByTitle", { title: tag.title }, { tagId }], tag)
			})

			// Write some data.
			writeTag(db, { id: "tag1", title: "Journal" })
			writeTag(db, { id: "tag2", title: "Work" })
			writePage(db, { id: "page1", content: "hello", tags: ["tag1", "tag2"] })
			writePage(db, { id: "page2", content: "world", tags: ["tag1"] })

			// Lets get all pages for a given tag.
			const pageIds = db
				.scan({ prefix: ["pagesByTag", { tagId: "tag1" }] })
				.map(({ key }) => namedTupleToObject(key))
				.map(({ pageId }) => pageId)

			assert.deepEqual(pageIds, ["page1", "page2"])

			const unsubscribe = db.subscribe(
				{ prefix: ["pagesByTag", { tagId: "tag1" }] },
				(writes) => {
					// Reactivity just like before
				}
			)
			after(unsubscribe)

			// Now suppose you really don't want to write all these indexes yourself.
			// You can still get reactivity...
			const getPagesByTagTitle = (
				db: ReadOnlyTupleDatabaseClientApi<Schema>,
				title: string
			) => {
				const tagIds = db
					.scan({ prefix: ["tagsByTitle", { title }] })
					.map(({ key }) => namedTupleToObject(key))
					.map(({ tagId }) => tagId)

				const pageIds = tagIds
					.map((tagId) => {
						return db
							.scan({ prefix: ["pagesByTag", { tagId }] })
							.map(({ key }) => namedTupleToObject(key))
							.map(({ pageId }) => pageId)
					})
					.reduce((a, b) => [...a, ...b], [])

				return pageIds
			}

			const { result, destroy } = subscribeQuery(
				db,
				(db) => getPagesByTagTitle(db, "Journal"),
				(pageIds) => {
					// Updated pageIds
				}
			)
			after(destroy)
			assert.deepEqual(result, ["page1", "page2"])
		})

		it("example 2", () => {
			type Schema =
				| { key: ["objects", { id: string }]; value: any }
				| {
						key: [
							"objectByProperty",
							{ property: string },
							{ value: any },
							{ id: string }
						]
						value: null
				  }

			const db = new TupleDatabaseClient<Schema>(
				new TupleDatabase(new InMemoryTupleStorage())
			)

			const removeObject = transactionalQuery<Schema>()((tx, id: string) => {
				const obj = tx.get(["objects", { id }])
				if (!obj) return

				tx.remove(["objects", { id }])

				for (const [property, value] of Object.entries(obj)) {
					if (property === "id") continue
					tx.remove(["objectByProperty", { property }, { value }, { id }])
				}
			})

			const writeObject = transactionalQuery<Schema>()((tx, obj: any) => {
				removeObject(tx, obj.id)

				const id = obj.id
				tx.set(["objects", { id }], obj)

				for (const [property, value] of Object.entries(obj)) {
					if (property === "id") continue
					tx.set(["objectByProperty", { property }, { value }, { id }], null)
				}
			})

			writeObject(db, { id: "1", name: "Chet", age: 31 })
			writeObject(db, { id: "2", name: "Joe", age: 29 })
			writeObject(db, { id: "3", name: "Ana", age: 29 })

			const objIdsWithAge29 = db
				.scan({
					prefix: ["objectByProperty", { property: "age" }, { value: 29 }],
				})
				.map(({ key }) => namedTupleToObject(key))
				.map(({ id }) => id)

			assert.deepEqual(objIdsWithAge29, ["2", "3"])

			// Could even have:
			// | {key: ["query", {id: string}], value: Query}
			// | {key: ["queryIndex", {queryId: string}, {objId: string}], value: null}
		})
	})

	// Last example => triplestore.test.ts
})
