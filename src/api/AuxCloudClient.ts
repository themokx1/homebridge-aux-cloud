import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import type { Logger } from 'homebridge';

import { encryptAesCbcZeroPadding } from './crypto';
import { AuxProducts } from './constants';

const TIMESTAMP_TOKEN_ENCRYPT_KEY = 'kdixkdqp54545^#*';
const PASSWORD_ENCRYPT_KEY = '4969fj#k23#';
const BODY_ENCRYPT_KEY = 'xgx3d*fe3478$ukx';

const AES_INITIAL_VECTOR = Buffer.from(
  [-22, -86, -86, 58, -69, 88, 98, -94, 25, 24, -75, 119, 29, 22, 21, -86].map(
    (value) => (value + 256) % 256,
  ),
);

const LICENSE =
  'PAFbJJ3WbvDxH5vvWezXN5BujETtH/iuTtIIW5CE/SeHN7oNKqnEajgljTcL0fBQQWM0XAAAAAAnBhJyhMi7zIQMsUcwR/PEwGA3uB5HLOnr+xRrci+FwHMkUtK7v4yo0ZHa+jPvb6djelPP893k7SagmffZmOkLSOsbNs8CAqsu8HuIDs2mDQAAAAA=';
const LICENSE_ID = '3c015b249dd66ef0f11f9bef59ecd737';
const COMPANY_ID = '48eb1b36cf0202ab2ef07b880ecda60d';

const SPOOF_APP_VERSION = '2.2.10.456537160';
const SPOOF_USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)';
const SPOOF_SYSTEM = 'android';
const SPOOF_APP_PLATFORM = 'android';

const REGION_URLS: Record<string, string> = {
  eu: 'https://app-service-deu-f0e9ebbb.smarthomecs.de',
  usa: 'https://app-service-usa-fd7cc04c.smarthomecs.com',
  cn: 'https://app-service-chn-31a93883.ibroadlink.com',
};

export interface AuxFamily {
  id: string;
  name: string;
}

export interface AuxDeviceSummary {
  endpointId: string;
  friendlyName: string;
  productId: string;
  devSession: string;
  devicetypeFlag: number;
  cookie: string;
  mac?: string;
  roomId?: string;
  familyId?: string;
  [key: string]: unknown;
}

export interface AuxDevice extends AuxDeviceSummary {
  params: Record<string, number>;
  state: number;
  lastUpdated?: string;
  ambientObservedAt?: number | null;
}

interface AuxCloudClientOptions {
  region?: string;
  logger?: Logger;
  requestTimeoutMs?: number;
}

interface RequestOptions {
  method: 'POST' | 'GET';
  endpoint: string;
  headers?: Record<string, string>;
  data?: unknown;
  dataRaw?: Buffer;
  params?: Record<string, string>;
}

interface DeviceQueryOptions {
  includeIds?: Set<string>;
  excludeIds?: Set<string>;
}

type QueryStateResponse = {
  event: {
    header?: {
      name?: string;
    };
    payload: {
      status: number;
      studata: Array<{ did: string; state: number }>;
      data?: Array<{ did: string; state: number }>;
      message?: string;
    };
  };
};

export class AuxApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuxApiError';
  }
}

export class AuxNetworkTimeoutError extends AuxApiError {
  constructor(message: string) {
    super(message);
    this.name = 'AuxNetworkTimeoutError';
  }
}

export class AuxCloudClient {
  private readonly http: AxiosInstance;

  private readonly log?: Logger;

  private readonly region: string;

  private readonly requestTimeoutMs: number;

  private identifier?: string;

  private password?: string;

  private loginsession?: string;

  private userid?: string;

  private families?: Map<string, AuxFamily>;

  constructor(options: AuxCloudClientOptions = {}) {
    this.region = options.region && REGION_URLS[options.region] ? options.region : 'eu';
    this.log = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;

    this.http = axios.create({
      baseURL: REGION_URLS[this.region] ?? REGION_URLS.eu,
      timeout: this.requestTimeoutMs,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
  }

  public isLoggedIn(): boolean {
    return Boolean(this.loginsession && this.userid);
  }

  public invalidateSession(): void {
    this.loginsession = undefined;
    this.userid = undefined;
  }

  public async ensureLoggedIn(identifier: string, password: string): Promise<void> {
    this.identifier = identifier;
    this.password = password;

    if (this.isLoggedIn()) {
      return;
    }

    await this.login(identifier, password);
  }

  public async login(identifier: string, password: string): Promise<void> {
    const timestampSeconds = Date.now() / 1000;
    const timestampValue = timestampSeconds.toString();

    const shaPassword = createHash('sha1').update(`${password}${PASSWORD_ENCRYPT_KEY}`).digest('hex');

    const payload = {
      email: identifier,
      password: shaPassword,
      companyid: COMPANY_ID,
      lid: LICENSE_ID,
    };

    const jsonPayload = JSON.stringify(payload);

    const token = createHash('md5').update(`${jsonPayload}${BODY_ENCRYPT_KEY}`).digest('hex');
    const md5Key = createHash('md5')
      .update(`${timestampValue}${TIMESTAMP_TOKEN_ENCRYPT_KEY}`)
      .digest();
    const encryptedBody = encryptAesCbcZeroPadding(
      AES_INITIAL_VECTOR,
      md5Key,
      Buffer.from(jsonPayload, 'utf8'),
    );

    const headers = this.getHeaders({
      'Content-Type': 'application/x-java-serialized-object',
      timestamp: timestampValue,
      token,
    });

    const response = await this.request<{ status: number; loginsession: string; userid: string }>(
      {
        method: 'POST',
        endpoint: 'account/login',
        headers,
        dataRaw: encryptedBody,
      },
    );

    if (response.status !== 0) {
      throw new Error(`Failed to login to AUX Cloud API: ${JSON.stringify(response)}`);
    }

    this.loginsession = response.loginsession;
    this.userid = response.userid;
    this.identifier = identifier;
    this.password = password;

    this.log?.debug('Logged in as %s', this.userid);
  }

  public async listFamilies(): Promise<AuxFamily[]> {
    if (!this.families) {
      this.families = new Map();
    }

    const response = await this.request<{
      status: number;
      data: { familyList: Array<{ familyid: string; name: string }> };
    }>({
      method: 'POST',
      endpoint: 'appsync/group/member/getfamilylist',
      headers: this.getHeaders(),
    });

    if (response.status !== 0) {
      throw new Error(`Failed to get AUX families: ${JSON.stringify(response)}`);
    }

    response.data.familyList.forEach((family) => {
      this.families?.set(family.familyid, {
        id: family.familyid,
        name: family.name,
      });
    });

    return Array.from(this.families.values());
  }

  public async listDevices(options: DeviceQueryOptions = {}): Promise<AuxDevice[]> {
    if (!this.identifier || !this.password) {
      throw new Error('Cannot list devices before logging in.');
    }

    if (!this.isLoggedIn()) {
      await this.login(this.identifier, this.password);
    }

    const families = await this.listFamilies();
    const discovered: AuxDevice[] = [];

    for (const family of families) {
      const owned = await this.fetchDevicesForFamily(family.id, false, options);
      const shared = await this.fetchDevicesForFamily(family.id, true, options);
      discovered.push(
        ...owned.map((dev) => ({ ...dev, familyId: family.id })),
        ...shared.map((dev) => ({ ...dev, familyId: family.id })),
      );
    }

    return discovered;
  }

  public async setDeviceParams(device: AuxDevice, values: Record<string, number>): Promise<void> {
    await this.actOnDeviceParams(device, 'set', Object.keys(values), Object.values(values));
  }

  public async refreshDeviceParams(device: AuxDevice): Promise<Record<string, number>> {
    const params = await this.actOnDeviceParams(device, 'get', [], []);
    device.params = params;
    return params;
  }

  private async fetchDevicesForFamily(
    familyId: string,
    shared: boolean,
    options: DeviceQueryOptions,
  ): Promise<AuxDevice[]> {
    const endpoint = shared
      ? 'appsync/group/sharedev/querylist?querytype=shared'
      : 'appsync/group/dev/query?action=select';

    const headers = this.getHeaders({ familyid: familyId });

    const response = await this.request<{
      status: number;
      data: {
        endpoints?: AuxDeviceSummary[];
        shareFromOther?: Array<{ devinfo: AuxDeviceSummary }>;
      };
    }>({
      method: 'POST',
      endpoint,
      headers,
      data: shared ? { endpointId: '' } : { pids: [] },
    });

    if (response.status !== 0) {
      throw new Error(`Failed to query devices for family ${familyId}: ${JSON.stringify(response)}`);
    }

    let devices: AuxDeviceSummary[] = [];
    if (response.data.endpoints) {
      devices = response.data.endpoints;
    } else if (response.data.shareFromOther) {
      devices = response.data.shareFromOther.map((item) => item.devinfo);
    }

    if (options.includeIds && options.includeIds.size > 0) {
      devices = devices.filter((dev) => options.includeIds?.has(dev.endpointId));
    }
    if (options.excludeIds && options.excludeIds.size > 0) {
      devices = devices.filter((dev) => !options.excludeIds?.has(dev.endpointId));
    }

    if (devices.length === 0) {
      return [];
    }

    const statePayload = await this.bulkQueryDeviceState(devices);
    const deviceStates = new Map<string, number>();

    statePayload.forEach(({ did, state }) => {
      deviceStates.set(did, state);
    });

    const enrichedDevices: AuxDevice[] = [];

    for (const device of devices) {
      const params: Record<string, number> = {};
      const specialParams = AuxProducts.getSpecialParamsList(device.productId);

      try {
        const result = await this.actOnDeviceParams(device, 'get', [], []);
        Object.assign(params, result);
      } catch (error) {
        this.log?.warn('Failed to retrieve base params for %s: %s', device.endpointId, (error as Error).message);
      }

      if (specialParams && specialParams.length > 0) {
        try {
          const result = await this.actOnDeviceParams(device, 'get', specialParams, []);
          Object.assign(params, result);
        } catch (error) {
          this.log?.warn(
            'Failed to retrieve special params for %s: %s',
            device.endpointId,
            (error as Error).message,
          );
        }
      }

      enrichedDevices.push({
        ...device,
        params,
        state: deviceStates.get(device.endpointId) ?? 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    return enrichedDevices;
  }

  private async bulkQueryDeviceState(devices: AuxDeviceSummary[]): Promise<Array<{ did: string; state: number }>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const queriedDevices = devices.map((device) => ({
      did: device.endpointId,
      devSession: device.devSession,
    }));

    const data = {
      directive: {
        header: this.getDirectiveHeader('DNA.QueryState', 'queryState', this.userid ?? 'sdk', {
          messageType: 'controlgw.batch',
          timstamp: `${timestamp}`,
        }),
        payload: {
          studata: queriedDevices,
          msgtype: 'batch',
        },
      },
    };

    const response = await this.request<QueryStateResponse>({
      method: 'POST',
      endpoint: 'device/control/v2/querystate',
      headers: this.getHeaders(),
      data,
    });

    const payload = response.event?.payload;

    if (response.event?.header?.name === 'ErrorResponse') {
      const status = payload?.status;
      const message = payload?.message ?? 'Unknown error querying device state';
      if (status === -49001) {
        throw new AuxNetworkTimeoutError(message);
      }
      throw new AuxApiError(message);
    }

    if (!payload || payload.status !== 0) {
      throw new Error(`Failed to query device state: ${JSON.stringify(response)}`);
    }

    const dataArray = (payload.data ?? payload.studata) || [];
    return dataArray.map((item) => ({ did: item.did, state: item.state }));
  }

  private async actOnDeviceParams(
    device: AuxDevice | AuxDeviceSummary,
    action: 'get' | 'set',
    params: string[],
    values: number[],
  ): Promise<Record<string, number>> {
    const cookie = JSON.parse(Buffer.from(device.cookie, 'base64').toString('utf8'));
    const mappedCookie = Buffer.from(
      JSON.stringify(
        {
          device: {
            id: cookie.terminalid,
            key: cookie.aeskey,
            devSession: device.devSession,
            aeskey: cookie.aeskey,
            did: device.endpointId,
            pid: device.productId,
            mac: device.mac,
          },
        },
        null,
        0,
      ),
    ).toString('base64');

    const payload = {
      directive: {
        header: this.getDirectiveHeader(
          'DNA.KeyValueControl',
          'KeyValueControl',
          device.endpointId,
        ),
        endpoint: {
          devicePairedInfo: {
            did: device.endpointId,
            pid: device.productId,
            mac: device.mac,
            devicetypeflag: device.devicetypeFlag,
            cookie: mappedCookie,
          },
          endpointId: device.endpointId,
          cookie: {},
          devSession: device.devSession,
        },
        payload: {
          act: action,
          params,
          vals: action === 'set' ? values.map((value) => [{ idx: 1, val: value }]) : [],
          did: device.endpointId,
        },
      },
    };

    if (action === 'get' && params.length === 1) {
      payload.directive.payload.vals = [[{ idx: 1, val: 0 }]];
    }

    const response = await this.request<{
      event: {
        header?: {
          name?: string;
        };
        payload?: {
          data?: string;
          status?: number;
          message?: string;
        };
      };
    }>({
      method: 'POST',
      endpoint: 'device/control/v2/sdkcontrol',
      headers: this.getHeaders(),
      params: { license: LICENSE },
      data: payload,
    });

    if (response.event?.header?.name === 'ErrorResponse') {
      const status = response.event.payload?.status;
      const message = response.event.payload?.message ?? 'Unknown error querying params';
      if (status === -49001) {
        throw new AuxNetworkTimeoutError(message);
      }
      throw new AuxApiError(message);
    }

    const encodedData = response.event?.payload?.data;
    if (!encodedData) {
      throw new Error(`Unexpected response querying device params: ${JSON.stringify(response)}`);
    }

    const parsed = JSON.parse(encodedData) as { params: string[]; vals: Array<Array<{ val: number }>> };
    const result: Record<string, number> = {};

    parsed.params.forEach((param, index) => {
      const entry = parsed.vals[index]?.[0];
      if (entry && typeof entry.val === 'number') {
        result[param] = entry.val;
      }
    });

    return result;
  }

  private getHeaders(additional: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      licenseId: LICENSE_ID,
      lid: LICENSE_ID,
      language: 'en',
      appVersion: SPOOF_APP_VERSION,
      'User-Agent': SPOOF_USER_AGENT,
      system: SPOOF_SYSTEM,
      appPlatform: SPOOF_APP_PLATFORM,
      loginsession: this.loginsession ?? '',
      userid: this.userid ?? '',
      ...additional,
    };
  }

  private getDirectiveHeader(
    namespace: string,
    name: string,
    messageIdPrefix: string,
    extra: Record<string, string> = {},
  ) {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      namespace,
      name,
      interfaceVersion: '2',
      senderId: 'sdk',
      messageId: `${messageIdPrefix}-${timestamp}`,
      ...extra,
    };
  }

  private async request<T>(options: RequestOptions, attempt = 1): Promise<T> {
    const { method, endpoint, headers, data, dataRaw, params } = options;

    try {
      const response = await this.http.request({
        method,
        url: `/${endpoint.replace(/^\//, '')}`,
        headers,
        params,
        data: dataRaw ?? data,
      });

      const payload = response.data;

      if (typeof payload !== 'string') {
        return payload as T;
      }

      try {
        return JSON.parse(payload) as T;
      } catch (error) {
        throw new Error(`Failed to parse AUX Cloud response: ${payload}`);
      }
    } catch (error) {
      const errCode = (error as { code?: string })?.code;
      const isTimeout = errCode === 'ECONNABORTED';
      const isNetwork = errCode === 'ENOTFOUND' || errCode === 'ECONNRESET';
      const shouldRetry = isTimeout || isNetwork;

      if (!shouldRetry || attempt >= 3) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const waitMs = Math.min(1000 * attempt, 4000);
      this.log?.warn(
        'Retrying AUX request %s (attempt %d) [%s]',
        endpoint,
        attempt + 1,
        errCode,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request(options, attempt + 1);
    }
  }
}
