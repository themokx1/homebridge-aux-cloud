import { HomebridgeAPI } from 'homebridge/lib/api';
import type { AuxDevice } from '../api/AuxCloudClient';
import { AC_POWER, AC_TEMPERATURE_AMBIENT, AC_TEMPERATURE_TARGET } from '../api/constants';
import type { AuxCloudPlatform } from '../platform';
import { AuxCloudPlatformAccessory } from '../platformAccessory';

function setup(providerKind = 'aux-home', temperatureUnit = 'C') {
  const api = new HomebridgeAPI();
  const { Characteristic, HAPStatus, Service, uuid } = api.hap;
  const accessory = new api.platformAccessory('Test AC', uuid.generate('test-ac'));
  const service = accessory.addService(Service.HeaterCooler, 'Test AC');
  service.addOptionalCharacteristic(Characteristic.StatusFault);
  service.setCharacteristic(Characteristic.HeatingThresholdTemperature, 24);
  service.setCharacteristic(Characteristic.CoolingThresholdTemperature, 24);
  if (temperatureUnit === 'F') {
    service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ maxValue: 100 }).updateValue(75);
    service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ maxValue: 100 }).updateValue(75);
  }
  const platform = {
    api, Characteristic, Service, providerKind, temperatureUnit,
    temperatureStep: 0.5,
    featureSwitches: new Set(),
    updateCachedDevice: jest.fn(),
    registerPendingCommandWithState: jest.fn(),
    schedulePendingCommandCompletion: jest.fn(),
    startDeviceCommand: jest.fn(),
  } as unknown as AuxCloudPlatform;
  const handler = new AuxCloudPlatformAccessory(platform, accessory);

  function update(params: AuxDevice['params']) {
    handler.updateAccessory({
      endpointId: 'test-ac', friendlyName: 'Test AC', productId: 'test',
      devSession: '', devicetypeFlag: 0, cookie: '', state: 1, params,
    });
  }

  return {
    update,
    current: service.getCharacteristic(Characteristic.CurrentTemperature),
    target: service.getCharacteristic(Characteristic.HeatingThresholdTemperature),
    active: service.getCharacteristic(Characteristic.Active),
    Active: Characteristic.Active,
    communicationFailure: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    startDeviceCommand: platform.startDeviceCommand,
  };
}

describe('HAP ambient temperature', () => {
  test('reports only CurrentTemperature unavailable when AUX Home supplies only a setpoint', async () => {
    const { active, Active, communicationFailure, current, startDeviceCommand, target, update } = setup();
    const push = jest.spyOn(current, 'updateValue');
    update({ [AC_POWER]: 0, [AC_TEMPERATURE_TARGET]: 180 });

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ hapStatus: communicationFailure }));
    await expect(current.handleGetRequest()).rejects.toBe(communicationFailure);
    await expect(target.handleGetRequest()).resolves.toBe(18);
    await expect(active.handleGetRequest()).resolves.toBe(Active.INACTIVE);
    await active.handleSetRequest(Active.ACTIVE);
    expect(startDeviceCommand).toHaveBeenCalledWith(expect.anything(), { [AC_POWER]: 1 });
  });

  test.each([NaN, Infinity, -Infinity, 9999])('rejects invalid AUX Home ambient value %s', async (ambient) => {
    const { communicationFailure, current, update } = setup();
    update({ [AC_TEMPERATURE_AMBIENT]: ambient });
    await expect(current.handleGetRequest()).rejects.toBe(communicationFailure);
  });

  test('updates a measured reading separately from the setpoint and handles a later missing reading', async () => {
    const { communicationFailure, current, target, update } = setup();
    update({ [AC_TEMPERATURE_TARGET]: 180 });
    await expect(current.handleGetRequest()).rejects.toBe(communicationFailure);

    update({ [AC_TEMPERATURE_AMBIENT]: 213, [AC_TEMPERATURE_TARGET]: 180 });
    expect(current.value).toBeCloseTo(21.3);
    await expect(current.handleGetRequest()).resolves.toBeCloseTo(21.3);
    await expect(target.handleGetRequest()).resolves.toBe(18);

    update({ [AC_TEMPERATURE_AMBIENT]: 0, [AC_TEMPERATURE_TARGET]: 250 });
    expect(current.value).toBe(0);
    await expect(current.handleGetRequest()).resolves.toBe(0);
    await expect(target.handleGetRequest()).resolves.toBe(25);

    update({ [AC_TEMPERATURE_TARGET]: 250 });
    await expect(current.handleGetRequest()).rejects.toBe(communicationFailure);
    await expect(target.handleGetRequest()).resolves.toBe(25);
  });

  test('reports AUX Home ambient temperature in HAP Celsius even when display units are Fahrenheit', async () => {
    const { current, update } = setup('aux-home', 'F');
    update({ [AC_TEMPERATURE_AMBIENT]: 213 });
    expect(current.value).toBeCloseTo(21.3);
    await expect(current.handleGetRequest()).resolves.toBeCloseTo(21.3);
  });

  test('preserves AC Freedom ambient conversion and existing missing-value fallback', async () => {
    const { current, update } = setup('ac-freedom');
    update({ [AC_TEMPERATURE_AMBIENT]: 217, [AC_TEMPERATURE_TARGET]: 180 });
    await expect(current.handleGetRequest()).resolves.toBeCloseTo(21.7);
    update({ [AC_TEMPERATURE_TARGET]: 180 });
    await expect(current.handleGetRequest()).resolves.toBe(24);
  });
});
