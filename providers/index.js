// Provider registry. To add a cloud: create providers/<name>.js exporting a provider object
// (see oci.js for the shape) and add it to PROVIDERS below. Nothing else needs to change.
import oci from './oci.js';
import generic from './generic.js';

export const PROVIDERS = [oci, generic];
export const getProvider = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
export const getShape = (provider, shapeId) =>
	provider.shapes.find((s) => s.id === shapeId) || provider.shapes[0];

export const HOURS_PER_MONTH = 730;

/**
 * The built-in price profile: every price is the provider's list price. A price profile is
 * { id, name, shapes: { 'provider/shape': { unitPrice?, gbPrice? } }, fees: { 'provider/fee': hourly } };
 * a price it leaves out falls back to the list price.
 */
export const LIST_PROFILE = Object.freeze({ id: 'list', name: 'List price (built in)', builtin: true, shapes: {}, fees: {} });

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A shape's $/unit-hr and $/GB-hr under a profile (list price where the profile has none). */
export function shapePrices(provider, shape, profile = LIST_PROFILE) {
	const o = profile?.shapes?.[`${provider.id}/${shape.id}`] || {};
	return {
		unitPrice: isPrice(o.unitPrice) ? o.unitPrice : shape.unitPrice,
		gbPrice: isPrice(o.gbPrice) ? o.gbPrice : shape.gbPrice,
	};
}

/** A cluster fee's hourly price under a profile. */
export function feeHourly(provider, fee, profile = LIST_PROFILE) {
	const v = profile?.fees?.[`${provider.id}/${fee.id}`];
	return isPrice(v) ? v : fee.hourly;
}

/** Prices a pool is billed at: its own override, else the profile's, else the list price. */
export function poolPrices(pool, profile = LIST_PROFILE) {
	const provider = getProvider(pool.providerId), shape = getShape(provider, pool.shapeId);
	const base = shapePrices(provider, shape, profile);
	return {
		unitPrice: isPrice(pool.unitPrice) ? pool.unitPrice : base.unitPrice,
		gbPrice: isPrice(pool.gbPrice) ? pool.gbPrice : base.gbPrice,
	};
}

/**
 * Hourly cost of one node. Providers may supply priceNode(shape, vcpu, memGB, overrides);
 * the default is unitPrice*units + gbPrice*memGB, where overrides carry the resolved prices.
 */
export function nodeHourly(provider, shape, vcpu, memGB, overrides = {}) {
	if (provider.priceNode) return provider.priceNode(shape, vcpu, memGB, overrides);
	const units = vcpu / shape.vcpuPerUnit;
	const unitPrice = overrides.unitPrice ?? shape.unitPrice;
	const gbPrice = overrides.gbPrice ?? shape.gbPrice;
	return units * unitPrice + memGB * gbPrice;
}
