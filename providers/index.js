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
 * Hourly cost of one node. Providers may supply priceNode(shape, vcpu, memGB, overrides);
 * the default is unitPrice*units + gbPrice*memGB, where overrides let the UI edit list prices.
 */
export function nodeHourly(provider, shape, vcpu, memGB, overrides = {}) {
	if (provider.priceNode) return provider.priceNode(shape, vcpu, memGB, overrides);
	const units = vcpu / shape.vcpuPerUnit;
	const unitPrice = overrides.unitPrice ?? shape.unitPrice;
	const gbPrice = overrides.gbPrice ?? shape.gbPrice;
	return units * unitPrice + memGB * gbPrice;
}
