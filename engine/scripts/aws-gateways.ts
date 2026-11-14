/**
 * Provisions the rotating egress on AWS: one API Gateway per target host per region.
 * Every request sent through a gateway leaves AWS from a different address of that
 * region's pool, so spreading hosts over several regions gives a large rotating pool.
 *
 *   npm run gateways -- create      # creates gateways, writes gateways.json
 *   npm run gateways -- delete      # removes everything this script created
 *
 * Needs AWS credentials in the environment with apigateway:* permissions.
 * AWS bills API Gateway per request and per GB transferred.
 */
import { writeFileSync } from 'node:fs';
import {
  APIGatewayClient, CreateDeploymentCommand, CreateResourceCommand, CreateRestApiCommand, DeleteRestApiCommand,
  GetResourcesCommand, GetRestApisCommand, PutIntegrationCommand, PutMethodCommand,
} from '@aws-sdk/client-api-gateway';

const HOSTS = [
  'www.youtube.com', 'www.reddit.com', 'old.reddit.com', 'news.google.com', 'www.pinterest.com',
  'www.instagram.com', 'cdn.syndication.twimg.com', 'www.bing.com', 'html.duckduckgo.com',
];
const REGIONS = (process.env.AWS_GATEWAY_REGIONS || 'us-east-1,us-west-2,eu-west-1,eu-central-1,ap-south-1,ap-southeast-1')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PREFIX = 'trend-engine-egress';
const STAGE = 'p';
const OUT = process.env.AWS_GATEWAYS_FILE || './gateways.json';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function existing(client: APIGatewayClient) {
  const apis: { id: string; name: string }[] = [];
  let position: string | undefined;
  do {
    const page = await client.send(new GetRestApisCommand({ limit: 500, position }));
    for (const a of page.items ?? []) if (a.id && a.name?.startsWith(PREFIX)) apis.push({ id: a.id, name: a.name });
    position = page.position;
  } while (position);
  return apis;
}

async function createOne(client: APIGatewayClient, host: string): Promise<string> {
  const api = await client.send(new CreateRestApiCommand({
    name: `${PREFIX} ${host}`,
    endpointConfiguration: { types: ['REGIONAL'] },
    binaryMediaTypes: [],
  }));
  const restApiId = api.id!;
  const root = (await client.send(new GetResourcesCommand({ restApiId }))).items!.find((r) => r.path === '/')!.id!;
  const proxy = (await client.send(new CreateResourceCommand({ restApiId, parentId: root, pathPart: '{proxy+}' }))).id!;
  const header = 'X-My-X-Forwarded-For';
  for (const [resourceId, uri, withPath] of [[root, `https://${host}/`, false], [proxy, `https://${host}/{proxy}`, true]] as const) {
    await client.send(new PutMethodCommand({
      restApiId, resourceId, httpMethod: 'ANY', authorizationType: 'NONE',
      requestParameters: { [`method.request.header.${header}`]: false, ...(withPath ? { 'method.request.path.proxy': true } : {}) },
    }));
    await client.send(new PutIntegrationCommand({
      restApiId, resourceId, httpMethod: 'ANY', type: 'HTTP_PROXY', integrationHttpMethod: 'ANY', uri,
      connectionType: 'INTERNET',
      requestParameters: {
        'integration.request.header.X-Forwarded-For': `method.request.header.${header}`,
        ...(withPath ? { 'integration.request.path.proxy': 'method.request.path.proxy' } : {}),
      },
    }));
  }
  await client.send(new CreateDeploymentCommand({ restApiId, stageName: STAGE }));
  return restApiId;
}

const action = process.argv[2];
if (action === 'create') {
  const map: Record<string, string[]> = {};
  for (const region of REGIONS) {
    const client = new APIGatewayClient({ region, maxAttempts: 8 });
    const have = new Map((await existing(client)).map((a) => [a.name, a.id]));
    for (const host of HOSTS) {
      let id = have.get(`${PREFIX} ${host}`);
      if (!id) { id = await createOne(client, host); await sleep(1500); }
      (map[host] ??= []).push(`https://${id}.execute-api.${region}.amazonaws.com/${STAGE}`);
      console.log(`${region}  ${host}  ${id}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`\nWrote ${OUT}. Set AWS_GATEWAYS_FILE=${OUT} for the engine.`);
} else if (action === 'delete') {
  for (const region of REGIONS) {
    const client = new APIGatewayClient({ region, maxAttempts: 8 });
    for (const api of await existing(client)) {
      await client.send(new DeleteRestApiCommand({ restApiId: api.id }));
      console.log(`deleted ${region} ${api.name}`);
      await sleep(31_000); // AWS allows one REST API deletion per 30 seconds
    }
  }
} else {
  console.error('usage: npm run gateways -- create|delete');
  process.exit(1);
}
