import { Id } from "../helpers/randomId"

export type Value =
	| Id
	| string
	| number
	| boolean
	| null
	| Array<Value>
	| { [key: string]: Value | undefined } // Undefined keys are ignored.
	| typeof MIN
	| typeof MAX

export type Tuple = Array<Value>

export const MIN = Symbol("min")
export const MAX = Symbol("max")

export type ScanArgs = {
	prefix?: Tuple
	gt?: Tuple
	gte?: Tuple
	lt?: Tuple
	lte?: Tuple
	limit?: number
}

export interface ReadOnlyStorage {
	scan(index: string, args: ScanArgs): Array<Tuple>
}

export type Writes = {
	[index: string]: { sets: Array<Tuple>; removes: Array<Tuple> }
}

export interface Storage {
	scan(index: string, args?: ScanArgs): Array<Tuple>
	transact(): Transaction
	commit(writes: Writes): void
}

export interface Transaction {
	writes: Writes
	scan(index: string, args?: ScanArgs): Array<Tuple>
	set(index: string, value: Tuple): Transaction
	remove(index: string, value: Tuple): Transaction
	commit(): void
}