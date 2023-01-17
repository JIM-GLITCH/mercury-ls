export class MultiMapSet<K,V>{
	map = new Map<K, Set<V>>();
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
            this.map.get(key)!.add(value);
        } else {
            this.map.set(key, new Set([value]));
        }
        return this;
    }
	get(key: K) {
        return this.map.get(key) ?? new Set();
    }
	has(key: K, value?: V): boolean {
        if (value === undefined) {
            return this.map.has(key);
        } else {
            const values = this.map.get(key);
            if (values) {
                return values.has(value)
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
                if(!values.delete(value)){
                    return false;
                }
                if(values.size==0){
                    this.map.delete(key);
                }
                return true;
   
            }
            return false;
        }
    }
}