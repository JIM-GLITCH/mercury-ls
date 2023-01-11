export class MultiMap<K,V>{
	private map = new Map<K, V[]>();
	constructor()
    constructor(elements: Array<[K, V]>)
    constructor(elements?: Array<[K, V]>){
		if (elements) {
            for (const [key, value] of elements) {
                this.add(key, value);
            }
        }
	}
	add(key: K, value: V): this {
        if (this.map.has(key)) {
            this.map.get(key)!.push(value);
        } else {
            this.map.set(key, [value]);
        }
        return this;
    }
	get(key: K): readonly V[] {
        return this.map.get(key) ?? [];
    }
	has(key: K, value?: V): boolean {
        if (value === undefined) {
            return this.map.has(key);
        } else {
            const values = this.map.get(key);
            if (values) {
                return values.indexOf(value) >= 0;
            }
            return false;
        }
    }
}