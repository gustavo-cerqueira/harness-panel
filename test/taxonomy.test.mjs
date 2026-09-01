import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CLUSTERS,
	UNCLASSIFIED,
	applyTaxonomy,
	classify,
	clusterCatalog,
	clusterMeta,
	emptyClusters,
	isClusteredKind,
	reportsGaps,
} from '../lib/taxonomy.mjs';

test('every cluster has a unique id and a trigger sentence that says when it fires', () => {
	const ids = CLUSTERS.map((cluster) => cluster.id);
	assert.equal(new Set(ids).size, ids.length, 'duplicate cluster id');
	for (const cluster of CLUSTERS) {
		assert.ok(cluster.label, `${cluster.id} has no label`);
		assert.ok(cluster.trigger.length > 25, `${cluster.id} trigger is too thin to distinguish it from a neighbour`);
	}
	assert.ok(ids.includes(UNCLASSIFIED), 'the honest fallback bucket must exist');
});

test('only the four inventoried kinds are clustered', () => {
	for (const kind of ['skills', 'commands', 'agents', 'mcp']) assert.equal(isClusteredKind(kind), true, kind);
	for (const kind of ['hooks', 'settings', 'rules']) assert.equal(isClusteredKind(kind), false, kind);
});

test('a curated name resolves exactly, and says so', () => {
	assert.deepEqual(classify('skills', { name: 'superpowers:systematic-debugging' }), {
		cluster: 'diagnosis',
		clusterSource: 'exact',
	});
	assert.deepEqual(classify('mcp', { name: 'basic-memory' }), { cluster: 'memory', clusterSource: 'exact' });
});

test('a plugin family covers skills that were never curated', () => {
	const result = classify('skills', { qualifiedName: 'opsx:some-brand-new-skill' });
	assert.deepEqual(result, { cluster: 'specification', clusterSource: 'family' });
});

// The whole reason SKILL_EXACT exists: a family rule is a claim about the
// plugin's centre of gravity, and the panel must not let it overrule a
// hand-checked fact about one member.
test('an exact entry beats the family rule of its own plugin', () => {
	assert.deepEqual(classify('skills', { qualifiedName: 'claude-mem:what-the' }), {
		cluster: 'diagnosis',
		clusterSource: 'exact',
	});
	assert.deepEqual(classify('skills', { qualifiedName: 'claude-mem:standup' }), {
		cluster: 'memory',
		clusterSource: 'family',
	});
});

test('the qualified name is tried before the bare one', () => {
	// `caveman:caveman-review` is verification; a bare `caveman-review` is not
	// curated at all, so matching the wrong candidate first would be visible.
	assert.deepEqual(classify('skills', { qualifiedName: 'caveman:caveman-review', name: 'caveman-review' }), {
		cluster: 'verification',
		clusterSource: 'exact',
	});
});

test('an unknown name lands in unclassified rather than the nearest plausible cluster', () => {
	assert.deepEqual(classify('skills', { name: 'totally-unknown-skill' }), {
		cluster: UNCLASSIFIED,
		clusterSource: 'none',
	});
	assert.deepEqual(classify('nope', { name: 'diagnose' }), { cluster: UNCLASSIFIED, clusterSource: 'none' });
});

test('applyTaxonomy stamps label and order alongside the id, in place', () => {
	const items = [{ qualifiedName: 'superpowers:systematic-debugging' }, { name: 'no-such-thing' }];
	const returned = applyTaxonomy('skills', items);
	assert.equal(returned, items, 'must mutate in place so the section payload is tagged');
	assert.equal(items[0].cluster, 'diagnosis');
	assert.equal(items[0].clusterLabel, clusterMeta('diagnosis').label);
	assert.equal(items[0].clusterOrder, clusterMeta('diagnosis').order);
	assert.equal(items[0].clusterSource, 'exact');
	// The row still has to render a header for itself after a section-only
	// refresh, which carries no meta block.
	assert.equal(items[1].cluster, UNCLASSIFIED);
	assert.equal(items[1].clusterLabel, 'Unclassified');
});

test('applyTaxonomy leaves unclustered kinds and non-arrays untouched', () => {
	const hooks = [{ name: 'PostToolUse' }];
	applyTaxonomy('hooks', hooks);
	assert.equal(hooks[0].cluster, undefined);
	assert.doesNotThrow(() => applyTaxonomy('skills', null));
});

test('emptyClusters reports the stages this workspace has no tool for', () => {
	const items = applyTaxonomy('skills', [{ name: 'superpowers:systematic-debugging' }]);
	const gaps = emptyClusters(items);
	assert.equal(gaps.includes('diagnosis'), false, 'a populated cluster is not a gap');
	assert.equal(gaps.includes('execution'), true);
	assert.equal(gaps.includes(UNCLASSIFIED), false, 'an empty fallback bucket is not a coverage gap');
});

test('the catalog is ordered and complete for the API meta block', () => {
	const catalog = clusterCatalog();
	assert.equal(catalog.length, CLUSTERS.length);
	catalog.forEach((cluster, index) => assert.equal(cluster.order, index));
	assert.ok(catalog.every((cluster) => cluster.trigger));
});

test('empty clusters are reported only where a gap is actionable', () => {
	assert.equal(reportsGaps('skills'), true);
	assert.equal(reportsGaps('commands'), true);
	// Nobody is missing a "planning MCP server" — seven empty clusters under six
	// servers is noise, not a finding.
	assert.equal(reportsGaps('mcp'), false);
	assert.equal(reportsGaps('agents'), false);
	assert.equal(reportsGaps('hooks'), false);
});
