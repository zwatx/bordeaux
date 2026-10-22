// Sanitized NI connector shapes; no project files, LabVIEW process or robot are accessed.
const { decodeLabviewNiInspection } = require('../dist-electron/electron/labviewNiTypes.js');
const status = name => `<Cluster><Name>${name}</Name><NumElts>3</NumElts><String><Name>Name</Name><Val/></String><EW><Name>Status</Name><Choice>Successful</Choice><Choice>Aborted</Choice><Choice>Incomplete</Choice><Val>0</Val></EW><Refnum><Name>notifier out</Name><RefKind>Notifier</RefKind><Val>0x00000000</Val></Refnum></Cluster>`;
const metadata = name => [[[[name], 'C:\\Fixture\\Command Status Info.ctl', false, 0, []]]];
exports.completionCatalog = () => {
  const vis = ['Calibrate', 'Drive Immediate', 'Reserve Drive', 'Config Drive Pipeline Command'].map(name => ({
    file: `Drive/Commands/${name}.vi`, target: 'Robot', status: 'inspected', description: '', modifiedBefore: false, modifiedAfter: false,
    dependenciesAvailable: true, dependencies: [], defaults: {}, connector: {
      numConnections: 2, captions: ['Command Info In', 'Command Info Out'], wireRequirements: [1, 1], ioStatus: [0, 1],
      conNum: [8, 0], dataTypes: [status('Command Info In'), status('Command Info Out')],
      extendedInformation: [metadata('Command Info In'), metadata('Command Info Out')],
    },
  }));
  const projectFile = 'C:\\Fixture\\Robot.lvproj';
  const result = decodeLabviewNiInspection({ schemaVersion: 'bordeaux-ni-inspection/1', projectFile, labviewVersion: '25.3.3f3',
    dirtyContext: false, inspectedAt: new Date().toISOString(), vis }, projectFile, vis);
  return { runtime: 'labview', projectName: 'Completion fixture', sourceFileCount: 4, scannedAt: '', warnings: [], commands: result.commands };
};
