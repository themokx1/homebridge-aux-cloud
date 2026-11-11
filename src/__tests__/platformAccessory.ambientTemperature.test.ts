import { HomebridgeAPI } from 'homebridge/lib/api';
import type { AuxDevice } from '../api/AuxCloudClient';
import { AC_FAN_SPEED, AC_SWING_VERTICAL, AuxFanSpeed, AC_POWER, AC_TEMPERATURE_AMBIENT, AC_TEMPERATURE_TARGET } from '../api/constants';
import type { AuxCloudPlatform } from '../platform';
import { AuxCloudPlatformAccessory } from '../platformAccessory';

function setup(providerKind = 'aux-home', temperatureUnit = 'C', config = {}) {
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
    api, Characteristic, Service, providerKind, temperatureUnit, config,
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
    thermostat: () => accessory.getService(Service.Thermostat),
    heaterCooler: () => accessory.getService(Service.HeaterCooler),
    sensor: () => accessory.getServiceById(Service.TemperatureSensor, 'ambientTemperature'),
    modeSwitch: () => accessory.getServiceById(Service.Switch, 'dry'),
    getSwitch: (key: string) => accessory.getServiceById(Service.Switch, key)?.getCharacteristic(Characteristic.On),
    Characteristic,
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
    await expect(current.handleGetRequest()).resolves.toBe(0);
    await expect(target.handleGetRequest()).resolves.toBe(25);
  });

  test('uses the last actual AUX Home reading for two polling intervals', async () => {
    jest.useFakeTimers();
    try {
      const { communicationFailure, current, update } = setup('aux-home', 'C', { pollInterval: 60 });
      update({ [AC_TEMPERATURE_AMBIENT]: 213 });
      update({});
      await expect(current.handleGetRequest()).resolves.toBeCloseTo(21.3);
      jest.advanceTimersByTime(120_001);
      await expect(current.handleGetRequest()).rejects.toBe(communicationFailure);
    } finally {
      jest.useRealTimers();
    }
  });

  test('adds an independent measured Celsius sensor and honors per-device switch settings', async () => {
    const { sensor, modeSwitch, Characteristic, update } = setup('aux-home', 'F', {
      devices: [{ endpointId: 'test-ac', ambientTemperatureSensor: true, homeKitSwitches: [] }],
    });
    update({ [AC_TEMPERATURE_AMBIENT]: 223 });
    await expect(sensor()?.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).resolves.toBeCloseTo(22.3);
    expect(modeSwitch()).toBeUndefined();
  });

  test('offers a single target characteristic on the opt-in thermostat service', async () => {
    const { thermostat, heaterCooler, Characteristic, update } = setup('aux-home', 'C', {
      devices: [{ endpointId: 'test-ac', homeKitService: 'thermostat' }],
    });
    update({ [AC_POWER]: 1, [AC_TEMPERATURE_AMBIENT]: 210, [AC_TEMPERATURE_TARGET]: 240 });
    expect(heaterCooler()).toBeUndefined();
    const service = thermostat()!;
    expect(service.testCharacteristic(Characteristic.HeatingThresholdTemperature)).toBe(false);
    expect(service.testCharacteristic(Characteristic.CoolingThresholdTemperature)).toBe(false);
    await expect(service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()).resolves.toBe(24);
    await expect(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).resolves.toBe(21);
  });

  test('exposes opt-in fan and vane controls using AUX Home parameter values', async () => {
    const { getSwitch, startDeviceCommand, update } = setup('aux-home', 'C', {
      devices: [{ endpointId: 'test-ac', homeKitSwitches: ['fanQuiet', 'vertical3'] }],
    });
    update({ [AC_FAN_SPEED]: AuxFanSpeed.LOW, [AC_SWING_VERTICAL]: 0 });
    await getSwitch('fanQuiet')?.handleSetRequest(true);
    expect(startDeviceCommand).toHaveBeenLastCalledWith(expect.anything(), { [AC_FAN_SPEED]: AuxFanSpeed.MUTE });
    await getSwitch('vertical3')?.handleSetRequest(true);
    expect(startDeviceCommand).toHaveBeenLastCalledWith(expect.anything(), { [AC_SWING_VERTICAL]: 3 });
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
