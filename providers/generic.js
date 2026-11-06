// Template / example for adding another cloud. Copy this file, rename, fill in shapes and prices.
// A shape is either flex (user picks units + memory) or fixed (fixedMemGB); price = units*unitPrice + GB*gbPrice.
// For non-linear pricing, export priceNode(shape, vcpu, memGB, overrides) -> $/hour instead.
export default {
	id: 'generic',
	name: 'Generic / custom (edit prices)',
	currency: 'USD',
	shapes: [
		{
			id: 'custom.flex', name: 'Custom flex node', arch: 'amd64', flex: true,
			unitLabel: 'vCPU', vcpuPerUnit: 1, minUnits: 1, maxUnits: 256, defaultUnits: 4,
			defaultMemPerUnit: 4, maxMemPerUnit: 32, unitPrice: 0.03, gbPrice: 0.004,
		},
	],
	clusterFees: [{ id: 'none', name: 'No cluster fee', hourly: 0 }],
};
