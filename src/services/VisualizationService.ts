import { Record } from 'neo4j-driver';
import { Neo4jClient } from '../database/Neo4jClient';
import { IntermediateGraph, Neo4jComponentPath } from '../entities';
import ProcessingService, { GraphFilterOptions, Range } from './processing/ProcessingService';
import { DependencyType, INeo4jComponentNode, INeo4jComponentPath } from '../database/entities';
import PostProcessingService from './processing/PostProcessingService';
import ViolationCyclicalDependenciesService from './violations/ViolationCyclicalDependenciesService';
import Violations from '../entities/violations';
import { IntermediateGraphWithViolations } from '../entities/Graph';
import PreProcessingService from './processing/PreProcessingService';
import { ViolationLayerService } from './violations';
import { ViolationBaseService } from './violations/ViolationBaseService';
import { Breadcrumb, BreadcrumbLayer, BreadcrumbOption } from '../entities/Breadcrumb';
import ElementParserService from './processing/ElementParserService';

export interface QueryOptions {
  id: string;
  layerDepth: number,
  dependencyDepth: number,
  showSelectedInternalRelations?: boolean,
  showDomainInternalRelations?: boolean,
  showExternalRelations?: boolean,
  showOutgoing?: boolean,
  showIncoming?: boolean,
  outgoingRange?: Partial<Range>,
  incomingRange?: Partial<Range>,
  selfEdges?: boolean,
  showWeakDependencies?: boolean;
  showStrongDependencies?: boolean;
  showEntityDependencies?: boolean;
}

export default class VisualizationService {
  private readonly client: Neo4jClient;

  constructor() {
    this.client = new Neo4jClient();
  }

  private async getParents(id: string) {
    const query = `
      MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')<-[r:CONTAINS*0..5]-(selectedParent) 
      RETURN selectedNode as source, r as path, selectedParent as target`;
    const records = await this.client.executeQuery<INeo4jComponentPath>(query);
    const preprocessor = new PreProcessingService(records, id);
    return new ProcessingService(preprocessor).formatToLPG('All parents');
  }

  private async getChildren(id: string, depth: number) {
    const query = `
      MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')-[r:CONTAINS*0..${depth}]->(moduleOrLayer) 
      RETURN selectedNode as source, r as path, moduleOrLayer as target`;
    const records = await this.client.executeQuery<INeo4jComponentPath>(query);
    const preprocessor = new PreProcessingService(records, id);
    return new ProcessingService(preprocessor).formatToLPG('All sublayers and modules');
  }

  private async processGraphAndGetViolations(
    neo4jRecords: Record<INeo4jComponentPath>[],
    selectedId?: string,
    options: GraphFilterOptions = {},
    treeGraph?: IntermediateGraph,
  ): Promise<IntermediateGraphWithViolations> {
    const {
      maxDepth,
      outgoingRange, incomingRange, selfEdges,
    } = options;

    const preprocessor = new PreProcessingService(neo4jRecords, selectedId, treeGraph);
    const processor = new ProcessingService(preprocessor);

    if (treeGraph) {
      const containRelationships = preprocessor.records
        .map((r) => [r.containSourceEdges, r.containTargetEdges])
        .flat().flat();
      preprocessor.records.forEach((r) => {
        r.dependencyEdges.flat().forEach((dep) => {
          dep.findAndSetParents(treeGraph.nodes.concat(preprocessor.nodes), containRelationships);
        });
      });
    }

    // Find the nodes that need to be replaced (and with which nodes).
    // Also, already remove the too-deep nodes
    let replaceMap: Map<string, string> | undefined;
    if (maxDepth !== undefined) {
      replaceMap = processor.getAbstractionMap(maxDepth);
    }

    let records: Neo4jComponentPath[];
    if (replaceMap && replaceMap.size > 0) {
      records = processor.applyAbstraction(processor.original.records, replaceMap);
    } else {
      records = processor.original.records;
    }

    // Count how many relationships each child of the selected node has
    records = processor
      .applyMinMaxRelationshipsFilter(records, true, outgoingRange?.min, outgoingRange?.max);
    records = processor
      .applyMinMaxRelationshipsFilter(records, false, incomingRange?.min, incomingRange?.max);

    const edges = processor.mergeDuplicateEdges(processor.getAllEdges(records));

    const nodes = processor.filterNodesByEdges(processor.original.nodes, edges);

    const replaceResult = processor.replaceEdgeWithParentRelationship(nodes, edges, 'contains');

    if (selfEdges === false) {
      replaceResult.dependencyEdges = processor.filterSelfEdges(replaceResult.dependencyEdges);
    }

    const graph: IntermediateGraph = {
      name: 'Dependency graph',
      nodes: replaceResult.nodes,
      edges: replaceResult.dependencyEdges,
    };

    const violations = await this.getGraphViolations(
      processor.original.records,
      graph,
      replaceMap,
    );

    return {
      graph,
      violations,
    };
  }

  private async getGraphViolations(
    records: Neo4jComponentPath[],
    graph: IntermediateGraph,
    replaceMap: Map<string, string> = new Map(),
  ): Promise<Violations> {
    const violationService = new ViolationCyclicalDependenciesService(this.client);

    const cyclicalDependencies = await violationService.getDependencyCycles();
    const formattedCyclDeps = violationService
      .extractAndAbstractDependencyCycles(cyclicalDependencies, records, graph, replaceMap);

    const layerViolationService = new ViolationLayerService(this.client);
    await layerViolationService.markAndStoreLayerViolations(records);
    let sublayerViolations = layerViolationService.extractLayerViolations();
    sublayerViolations = sublayerViolations
      .map((v) => ViolationBaseService.replaceWithCorrectEdgeIds(v, graph));

    return {
      dependencyCycles: formattedCyclDeps,
      subLayers: sublayerViolations,
    };
  }

  public async getGraphFromSelectedNode({
    id, layerDepth, dependencyDepth,
    showExternalRelations, showDomainInternalRelations, showSelectedInternalRelations,
    showOutgoing, showIncoming, outgoingRange, incomingRange, selfEdges,
    showWeakDependencies, showStrongDependencies, showEntityDependencies,
  }: QueryOptions): Promise<IntermediateGraphWithViolations> {
    const addParentsFilter = (query: string) => {
      let q = `${query}`;

      q += 'AND (false ';

      if (showSelectedInternalRelations && !showDomainInternalRelations) {
        q += 'OR (selectedNode)-[:CONTAINS*]->(dependency) ';
      }
      if (showDomainInternalRelations) {
        q += 'OR (selectedDomain:Domain)-[:CONTAINS*]->(dependency) '; // Dependency should be in the same domain
      }
      if (showExternalRelations) {
        q += 'OR NOT (selectedDomain:Domain)-[:CONTAINS*]->(dependency) '; // Dependency should not be in the same domain
      }

      q += ') ';

      return q;
    };

    const addDependencyTypeFilter = (query: string) => {
      const showAllDependencies = !!showWeakDependencies
        && !!showStrongDependencies && !!showEntityDependencies;

      if (showAllDependencies) return query;
      let q = `${query}`;

      q += 'AND (false ';

      if (!showAllDependencies && showWeakDependencies) {
        q += `OR all(rel in r2 WHERE rel.dependencyType = '${DependencyType.WEAK}') `;
      }
      if (!showAllDependencies && showStrongDependencies) {
        q += `OR all(rel in r2 WHERE rel.dependencyType = '${DependencyType.STRONG}') `;
      }
      if (!showAllDependencies && showEntityDependencies) {
        q += `OR all(rel in r2 WHERE rel.dependencyType = '${DependencyType.ENTITY}') `;
      }

      q += ') ';

      return q;
    };

    const buildQuery = (outgoing: boolean = true) => {
      let query = `
            // Get all modules that belong to the selected node
            MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')-[r1:CONTAINS*0..4]->(moduleOrLayer)${!outgoing ? '<' : ''}-[r2*0..${dependencyDepth}]-${outgoing ? '>' : ''}(dependency:Module)
            // Get the domain of the selected node
            MATCH (selectedNode)<-[:CONTAINS*0..4]-(selectedDomain:Domain)
            // Get the layers, application and domain of all dependencies
            MATCH (dependency)<-[r3:CONTAINS*0..4]-(parent)
            WHERE true `;

      query = addParentsFilter(query);
      query = addDependencyTypeFilter(query);

      if (outgoing) {
        query += 'RETURN DISTINCT selectedNode as source, r1 + r2 + reverse(r3) as path, parent as target';
      } else {
        query += 'RETURN DISTINCT parent as source, r1 + r2 + reverse(r3) as path, selectedNode as target';
      }
      return query;
    };

    const graphs: IntermediateGraph[] = await Promise.all([
      this.getParents(id),
      this.getChildren(id, layerDepth),
    ]);
    const { graph: treeGraph } = new PostProcessingService(...graphs);

    const neo4jRecords: Record<INeo4jComponentPath>[] = [];

    if (showOutgoing) {
      const records = await this.client
        .executeQuery<INeo4jComponentPath>(buildQuery(true));
      neo4jRecords.push(...records);
    }
    if (showIncoming) {
      const records = await this.client
        .executeQuery<INeo4jComponentPath>(buildQuery(false));
      neo4jRecords.push(...records);
    }
    const {
      graph: dependencyGraph,
      violations,
    } = await this.processGraphAndGetViolations(neo4jRecords, id, {
      maxDepth: layerDepth,
      selfEdges,
      incomingRange,
      outgoingRange,
    }, treeGraph);

    const { graph } = new PostProcessingService(treeGraph, dependencyGraph);

    await this.client.destroy();

    return {
      graph,
      violations,
    };
  }

  /**
   * Get a list of the breadcrumbs of the selected node, including a list of possible other children
   * of the parent.
   * @param id
   */
  public async getBreadcrumbsOptionsFromSelectedNode(id: string): Promise<Breadcrumb[]> {
    const records = await this.client
      .executeQuery<{ parent: INeo4jComponentNode, option: INeo4jComponentNode }>(`
        MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')<-[r1:CONTAINS*1..4]-(parent)-[r2:CONTAINS]->(option)
        RETURN parent, option
      `);

    const breadcrumbParents = records.reduce((parents: BreadcrumbLayer[], record) => {
      const parent = record.get('parent');
      if (parents.some((p) => p.id === parent.elementId)) {
        return parents;
      }
      const layerLabel = ElementParserService.getLongestLabel(parent.labels);
      parents.push({ layerLabel, id: parent.elementId });
      return parents;
    }, [])
      // Reverse the ordering, because now the lowest layer is the first element
      // and the "Domain" layer is the last
      .reverse();

    const breadcrumbs: Breadcrumb[] = breadcrumbParents.map((p) => {
      const optionNodes = records.filter((r) => r.get('parent').elementId === p.id);
      const options: BreadcrumbOption[] = optionNodes.map((n) => {
        const option = n.get('option');
        const [layer] = ElementParserService.extractLayer(option.labels);
        return { id: option.elementId, layerLabel: layer, name: option.properties.simpleName };
      });
      return { ...p, options };
    });

    // The current label/id of the breadcrumbs are still the parents,
    // while they should be layer label and the current selected node ID of that layer.
    return breadcrumbs.map((breadcrumb, i, all): Breadcrumb => {
      const { layerLabel } = breadcrumb.options[0];
      // ID is the ID of this parent's child, or the selected node if it does not exist
      const elementId = all[i + 1]?.id ?? id;
      return {
        layerLabel,
        id: elementId,
        options: breadcrumb.options,
      };
    });
  }
}
