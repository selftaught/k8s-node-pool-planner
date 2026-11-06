// Oracle Cloud Infrastructure (OKE worker nodes). List prices, pay-as-you-go, USD.
// Prices are defaults only (editable per pool in the UI); verify at oracle.com/cloud/price-list.
// x86 shapes: 1 OCPU = 2 vCPU (hyperthreads). Ampere (A1/A2): 1 OCPU = 1 vCPU.
const flex = (id, name, arch, vcpuPerUnit, unitPrice, gbPrice, maxUnits, gbPerUnitMax = 64) => ({
	id, name, arch, flex: true, unitLabel: 'OCPU', vcpuPerUnit,
	minUnits: 1, maxUnits, defaultUnits: 2, defaultMemPerUnit: 8, maxMemPerUnit: gbPerUnitMax,
	unitPrice, gbPrice,
});
const fixed = (id, name, arch, ocpus, vcpuPerUnit, memGB, unitPrice, gbPrice) => ({
	id, name, arch, flex: false, unitLabel: 'OCPU', vcpuPerUnit,
	minUnits: ocpus, maxUnits: ocpus, defaultUnits: ocpus, fixedMemGB: memGB, unitPrice, gbPrice,
});

export default {
	id: 'oci',
	name: 'Oracle Cloud (OKE)',
	currency: 'USD',
	shapes: [
		flex('VM.Standard.E4.Flex', 'VM.Standard.E4.Flex (AMD EPYC)', 'amd64', 2, 0.025, 0.0015, 64),
		flex('VM.Standard.E5.Flex', 'VM.Standard.E5.Flex (AMD EPYC)', 'amd64', 2, 0.03, 0.002, 94),
		flex('VM.Standard3.Flex', 'VM.Standard3.Flex (Intel)', 'amd64', 2, 0.04, 0.0015, 32),
		flex('VM.Optimized3.Flex', 'VM.Optimized3.Flex (Intel, high freq)', 'amd64', 2, 0.054, 0.0015, 18, 64),
		flex('VM.Standard.A1.Flex', 'VM.Standard.A1.Flex (Ampere)', 'arm64', 1, 0.01, 0.0015, 80, 64),
		flex('VM.Standard.A2.Flex', 'VM.Standard.A2.Flex (Ampere)', 'arm64', 1, 0.014, 0.002, 78, 64),
		fixed('BM.Standard.E4.128', 'BM.Standard.E4.128 (bare metal)', 'amd64', 128, 2, 2048, 0.025, 0.0015),
		fixed('BM.Standard.A1.160', 'BM.Standard.A1.160 (bare metal)', 'arm64', 160, 1, 1024, 0.01, 0.0015),
	],
	// Flat per-cluster fee (hourly). Basic clusters are free; Enhanced is $0.10/hr.
	clusterFees: [
		{ id: 'basic', name: 'OKE Basic cluster', hourly: 0 },
		{ id: 'enhanced', name: 'OKE Enhanced cluster', hourly: 0.1 },
	],
};
