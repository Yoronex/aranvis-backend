import { Record } from 'neo4j-driver';
import { Neo4jClient } from '../database/Neo4jClient';
import { Graph } from '../entities';
import GraphProcessingService, { GraphFilterOptions } from './processing/GraphProcessingService';
import { Neo4jComponentPath } from '../database/entities';
import GraphPostProcessingService from './processing/GraphPostProcessingService';

export interface QueryOptions {
  id: string;
  layerDepth: number,
  dependencyDepth: number,
  onlyInternalRelations?: boolean,
  onlyExternalRelations?: boolean,
  showDependencies?: boolean,
  showDependents?: boolean,
  dependencyRange?: {
    min?: number;
    max?: number;
  },
  dependentRange?: {
    min?: number;
    max?: number;
  },
  selfEdges?: boolean,
}

export default class GraphVisualizationService {
  private client: Neo4jClient;

  constructor() {
    this.client = new Neo4jClient();
  }

  private async getParents(id: string) {
    const query = `
      MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')<-[r:CONTAINS*0..5]-(selectedParent) 
      RETURN selectedNode as source, r as path, selectedParent as target`;
    const records = await this.client.executeQuery<Neo4jComponentPath>(query);
    return new GraphProcessingService().formatToLPG(records, 'All parents', { selectedId: id });
  }

  private async getChildren(id: string, depth: number) {
    const query = `
      MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')-[r:CONTAINS*0..${depth}]->(moduleOrLayer) 
      RETURN selectedNode as source, r as path, moduleOrLayer as target`;
    const records = await this.client.executeQuery<Neo4jComponentPath>(query);
    return new GraphProcessingService().formatToLPG(records, 'All sublayers and modules', { selectedId: id });
  }

  public async getGraphFromSelectedNode({
    id, layerDepth, dependencyDepth, onlyExternalRelations, onlyInternalRelations,
    showDependencies, showDependents, dependencyRange, dependentRange, selfEdges,
  }: QueryOptions) {
    const buildQuery = (dependencies: boolean = true) => {
      let query = `
            MATCH (selectedNode WHERE elementId(selectedNode) = '${id}')-[r1:CONTAINS*0..5]->(moduleOrLayer)${!dependencies ? '<' : ''}-[r2*1..${dependencyDepth}]-${dependencies ? '>' : ''}(dependency:Module) // Get all modules that belong to the selected node
            MATCH (selectedNode)<-[:CONTAINS*0..5]-(selectedDomain:Domain)                                   // Get the domain of the selected node
            MATCH (dependency)<-[r3:CONTAINS*0..5]-(parent)                                                  // Get the layers, application and domain of all dependencies
            WHERE true `;
      if (onlyInternalRelations) {
        query += 'AND (selectedDomain:Domain)-[:CONTAINS*]->(dependency) '; // Dependency should be in the same domain
      }
      if (onlyExternalRelations) {
        query += 'AND NOT (selectedDomain:Domain)-[:CONTAINS*]->(dependency) '; // Dependency should not be in the same domain
      }

      if (dependencies) {
        query += 'RETURN DISTINCT selectedNode as source, r1 + r2 + reverse(r3) as path, parent as target';
      } else {
        query += 'RETURN DISTINCT parent as source, r1 + r2 + reverse(r3) as path, selectedNode as target';
      }
      return query;
    };

    const graphs: Graph[] = await Promise.all([
      this.getParents(id),
      this.getChildren(id, layerDepth),
    ]);
    if (showDependencies) {
      const records = await this.client
        .executeQuery<Neo4jComponentPath>(buildQuery(true));
      const dependencyGraph = new GraphProcessingService().formatToLPG(records, 'All dependencies and their parents', {
        selectedId: id,
        maxDepth: layerDepth,
        minRelationships: dependencyRange?.min,
        maxRelationships: dependencyRange?.max,
        selfEdges,
      });
      graphs.push(dependencyGraph);
    }
    if (showDependents) {
      const records = await this.client
        .executeQuery<Neo4jComponentPath>(buildQuery(false));
      const dependentGraph = new GraphProcessingService().formatToLPG(records, 'All dependents and their parents', {
        selectedId: id,
        maxDepth: layerDepth,
        minRelationships: dependentRange?.min,
        maxRelationships: dependentRange?.max,
        selfEdges,
      });
      graphs.push(dependentGraph);
    }

    await this.client.destroy();

    return new GraphPostProcessingService(...graphs).graph;
  }
}
