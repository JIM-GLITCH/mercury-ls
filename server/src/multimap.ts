export class MultiMap<K,V>{
	map = new Map<K, V[]>();
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
       delete(key: K, value?: V): boolean {
        if (value === undefined) {
            return this.map.delete(key);
        } else {
            const values = this.map.get(key);
            if (values) {
                const index = values.indexOf(value);
                if (index >= 0) {
                    if (values.length === 1) {
                        this.map.delete(key);
                    } else {
                        values.splice(index, 1);
                    }
                    return true;
                }
            }
            return false;
        }
    }
}