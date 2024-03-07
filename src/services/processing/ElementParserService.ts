import { INeo4jComponentRelationship, INeo4jComponentNode } from '../../database/entities';
import { NodeData } from '../../entities/Node';
import { EdgeData } from '../../entities/Edge';
import { Neo4jComponentRelationship } from '../../entities';
import { Graph, IntermediateGraph } from '../../entities/Graph';

export default class ElementParserService {
  /**
   * Given a Neo4j node, format it to a CytoScape NodeData object
   * @param node
   * @param selectedId
   */
  public static toNodeData(
    node: INeo4jComponentNode,
    selectedId?: string,
  ): NodeData {
    return {
      id: node.elementId,
      label: node.properties.simpleName,
      properties: {
        fullName: node.properties.fullName,
        kind: node.properties.layerName,
        layer: node.labels.sort((a, b) => b.length - a.length)[0],
        color: node.properties.color,
        depth: Number(node.properties.depth),
        selected: node.elementId === selectedId ? 'true' : 'false',
      },
    };
  }

  /**
   * Given a Neo4J relationship, format it to a CytoScape EdgeData format.
   * @param edge
   */
  public static toEdgeData(
    edge: INeo4jComponentRelationship | Neo4jComponentRelationship,
  ): EdgeData {
    return {
      id: edge.elementId,
      source: edge.startNodeElementId,
      target: edge.endNodeElementId,
      interaction: edge.type.toLowerCase(),
      properties: {
        referenceKeys: [edge.properties.id.split('__')[0]],
        weight: 1,
        violations: {
          subLayer: 'violations' in edge ? edge.violations.subLayer : false,
          dependencyCycle: 'violations' in edge ? edge.violations.dependencyCycle : false,
          any: 'violations' in edge ? edge.violations.subLayer || edge.violations.dependencyCycle : false,
        },
        referenceTypes: [edge.properties.referenceType],
        dependencyTypes: edge.properties.dependencyType
          ? [edge.properties.dependencyType] : [],
      },
    };
  }

  public static toGraph(intermediateGraph: IntermediateGraph): Graph {
    return {
      name: intermediateGraph.name,
      nodes: [...intermediateGraph.nodes.values()],
      edges: [...intermediateGraph.edges.values()],
    };
  }
}
