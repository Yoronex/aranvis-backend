import { Record } from 'neo4j-driver';
import { IntermediateGraph, Neo4jComponentPath } from '../../entities';
import { INeo4jComponentPath, Neo4jRelationshipMappings } from '../../database/entities';
import { MapSet } from '../../entities/MapSet';
import { filterDuplicates } from '../../helpers/array';
import Neo4jComponentNode from '../../entities/Neo4jComponentNode';

export default class PreProcessingService {
  public readonly nodes: MapSet<Neo4jComponentNode>;

  public readonly selectedNode?: Neo4jComponentNode;

  public readonly records: Neo4jComponentPath[];

  /**
   * @param records Unprocessed Neo4j paths
   * @param selectedId ID of the selected node (to highlight it)
   * @param context Optional graph that can provide more context to the given records,
   * i.e. when nodes or edges are missing from the given records.
   * @param selectedDomain Whether the starting point of the selection is one or more domains.
   * Overridden by selectedId, if it exists.
   */
  constructor(
    records: Record<INeo4jComponentPath>[],
    public readonly selectedId?: string,
    public readonly context?: IntermediateGraph,
    selectedDomain: boolean = true,
  ) {
    const allContainRelationships: Neo4jRelationshipMappings = {
      sourceToTargets: new Map(),
      targetToSource: new Map(),
    };

    // Create a mapping from source to targets and target to source to efficiently
    // find a node's parents later
    records.forEach((record) => record.get('path')
      .forEach((rel) => {
        if (rel.type !== 'CONTAINS') return;
        allContainRelationships.targetToSource.set(rel.endNodeElementId, rel.startNodeElementId);
        if (allContainRelationships.sourceToTargets.has(rel.startNodeElementId)) {
          const targets = allContainRelationships.sourceToTargets.get(rel.startNodeElementId);
          if (targets && !targets.includes(rel.endNodeElementId)) {
            targets?.push(rel.endNodeElementId);
          }
        } else {
          allContainRelationships.sourceToTargets
            .set(rel.startNodeElementId, [rel.endNodeElementId]);
        }
      }));

    this.nodes = this.getAllNodes(records, allContainRelationships);
    this.selectedNode = this.nodes.get(selectedId);

    const chunkRecords = this.splitRelationshipsIntoChunks(
      records,
      this.selectedNode ? this.selectedNode.layer === 'Domain' : selectedDomain,
    );
    this.records = this.onlyKeepLongestPaths(chunkRecords);
  }

  /**
   * Given a list of records, return a list of all unique nodes in the records
   * @param records
   * @param allContainRelationships
   * @param selectedId
   */
  private getAllNodes(
    records: Record<INeo4jComponentPath>[],
    allContainRelationships: Neo4jRelationshipMappings,
  ): MapSet<Neo4jComponentNode> {
    const nodeSet: MapSet<Neo4jComponentNode> = new MapSet();
    records.forEach((r) => [r.get('source'), r.get('target')]
      .forEach((field) => {
        const nodeId = field.elementId;
        if (nodeSet.has(nodeId)) return;
        nodeSet.set(nodeId, new Neo4jComponentNode(field));
      }));

    nodeSet.forEach((n) => n.setParentChildNodes(nodeSet, allContainRelationships));

    this.calculateDependencyProfile(nodeSet);
    return nodeSet;
  }

  /**
   * Recursively calculate the dependency profiles for the given
   * nodes within the context of the graph
   * @param layerNodes Set of nodes that are in the same layer in the graph
   * @private
   */
  private getDependencyProfile(
    layerNodes: MapSet<Neo4jComponentNode>,
  ): void {
    // const layerEdges = containEdges.filter((e) => layerNodes.has(e.data.target));
    // if (layerEdges.size === 0) return new MapSet<Node>();
    // const parents = allNodes.filter((n) => !!layerEdges.find((e) => e.data.source === n.data.id));
    const parentList = layerNodes.map((n) => n.parent)
      .filter((p) => p != null)
      .map((p) => p!)
      .filter(filterDuplicates);
    if (parentList.length === 0) return;
    const parents = MapSet.from(...parentList);

    parents.forEach((parent) => {
      // eslint-disable-next-line no-param-reassign
      parent.dependencyProfile = parent.children
        .reduce((newProfile, child) => {
          const childProfile = child.dependencyProfile;
          const result = newProfile.map((x, i) => x + childProfile[i]);
          return [result[0], result[1], result[2], result[3]];
        }, [0, 0, 0, 0]);
    });
    this.getDependencyProfile(parents);
  }

  /**
   * Given a set of nodes, calculate the dependency profile for each node
   * @param nodes
   * @private
   */
  private calculateDependencyProfile(
    nodes: MapSet<Neo4jComponentNode>,
  ): void {
    // Get all nodes that do not have any children
    const leafNodes = nodes.filter((n) => n.children.length === 0);
    this.getDependencyProfile(leafNodes);
  }

  /**
   * Return the given records, but split/group the relationships into chunks of the same
   * type of relationship. See also this.groupRelationships().
   * @param records
   * @param selectedDomain
   */
  private splitRelationshipsIntoChunks(
    records: Record<INeo4jComponentPath>[],
    selectedDomain: boolean,
  ): Neo4jComponentPath[] {
    const contextNodes = this.context ? this.context.nodes.concat(this.nodes) : this.nodes;

    return records.map((record) => (new Neo4jComponentPath(
      record,
      contextNodes,
      selectedDomain,
    )));
  }

  /**
   * Keep only the paths that go from selected node to the domain node of the relationship
   * We have to delete any duplicates, because otherwise all these extra paths count towards
   * the total number of relationship a leaf has.
   * @param records
   */
  private onlyKeepLongestPaths(records: Neo4jComponentPath[]) {
    const seenPaths = new Map<string, number>();
    return records
      .map((record) => {
        // String that will uniquely identify this dependency (sequence).
        const pathId = record.dependencyEdges.flat().map((e) => e.elementId).join(',');

        let currDepth = 0;
        if (seenPaths.has(pathId)) {
          currDepth = seenPaths.get(pathId)!;
        }

        seenPaths.set(pathId, Math.max(currDepth, record.targetDepth));

        return record;
      }).filter((record) => {
        const pathId = record.dependencyEdges.flat().map((e) => e.elementId).join(',');
        const depth = seenPaths.get(pathId) || 0;

        return record.targetDepth === depth;
      });
  }
}
