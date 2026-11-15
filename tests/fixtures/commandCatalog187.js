// A realistic LabVIEW-style catalog: 187 commands in 13 folders, with near-duplicates ((old), v2, Copy of)
// and diagnostics under Diagnostics/Test and Diagnostics/SysId. Shared by command search tests and harnesses.
export const commandCatalog187 = (() => {
  const pct = (name, label, unit) => ({ name, label, unit, valueType: 'DBL', role: 'argument', schema: { kind: 'number', valueType: 'DBL' } });
  const en = (name, label, values) => ({ name, label, valueType: 'Enum', role: 'argument', schema: { kind: 'enum', valueType: 'Enum', enumValues: values } });
  const bool = (name, label) => ({ name, label, valueType: 'Boolean', role: 'argument', schema: { kind: 'boolean', valueType: 'Boolean' } });
  const status = { name: 'Command Info Out.Status', label: 'Completion status', schema: { kind: 'enum', valueType: 'Enum', enumValues: ['Successful', 'Aborted', 'Timed out'] } };
  const outB = (name, label) => ({ name, label, schema: { kind: 'boolean', valueType: 'Boolean' } });
  const outN = (name, label, unit) => ({ name, label, unit, schema: { kind: 'number', valueType: 'DBL' } });
  const T = pct('Timeout', 'Timeout', 's');
  // [folder, label, params, outputs]
  const spec = {
    Drive: [
      ['Drive Stop'], ['Drive Brake Mode'], ['Drive Coast Mode'], ['Drive Reset Gyro'], ['Drive Zero Encoders'],
      ['Drive Set Heading', [pct('Heading', 'Heading', 'deg')]], ['Drive Turn To Angle', [pct('Angle', 'Angle', 'deg'), T], [outN('Error', 'Heading error', 'deg')]],
      ['Drive Align To Speaker', [T], [outB('Aligned', 'Aligned')]], ['Drive Align To AprilTag', [pct('Tag', 'Tag ID'), T], [outB('Aligned', 'Aligned')]],
      ['Drive Align To Amp', [T], [outB('Aligned', 'Aligned')]], ['Drive Straight Distance', [pct('Distance', 'Distance', 'm'), pct('Speed', 'Speed', '%')]],
      ['Drive Arcade Timed', [pct('Speed', 'Speed', '%'), pct('Turn', 'Turn', '%'), pct('Time', 'Time', 's')]], ['Drive Set Max Speed', [pct('Speed', 'Max speed', 'm/s')]],
      ['Drive Lock Wheels'], ['Drive Field Relative', [bool('Enabled', 'Field relative')]], ['Drive Slow Mode', [bool('Enabled', 'Slow')]],
      ['Drive Reset Pose From Vision'], ['Drive Wait Until Stopped', [T]], ['Drive Point Wheels Forward'], ['Drive Balance', [T], [outB('Level', 'Level')]],
    ],
    Intake: [
      ['Intake In'], ['Intake Out'], ['Intake Stop'], ['Intake Deploy'], ['Intake Retract'], ['Intake Set Speed', [pct('Speed', 'Speed', '%')]],
      ['Intake Until Note', [T], [outB('Has Note', 'Has note')]], ['Intake Until Note Or Timeout', [T], [outB('Has Note', 'Has note')]],
      ['Intake Deploy And Run'], ['Intake Ground Pickup', [T], [outB('Has Note', 'Has note')]], ['Intake Source Pickup', [T], [outB('Has Note', 'Has note')]],
      ['Intake Hold Note'], ['Intake Eject Slow'], ['Intake Eject Fast'], ['Intake Wait For Note', [T], [outB('Has Note', 'Has note')]],
      ['Intake Pivot To Angle', [pct('Angle', 'Angle', 'deg')]], ['Intake Pivot Home'], ['Intake Pivot Zero'], ['Intake Clear Jam'],
      ['Intake Handoff To Indexer', [T]], ['Intake In (old)'], ['Intake In v2'], ['Copy of Intake Until Note', [T], [outB('Has Note', 'Has note')]],
      ['Intake Rollers Only', [pct('Speed', 'Speed', '%')]], ['Intake Center Note'],
    ],
    Indexer: [
      ['Indexer Feed'], ['Indexer Reverse'], ['Indexer Stop'], ['Indexer Until Beam Break', [T], [outB('Broken', 'Beam broken')]],
      ['Indexer Index One'], ['Indexer Clear'], ['Indexer Feed To Shooter', [T]], ['Indexer Hold'], ['Indexer Set Speed', [pct('Speed', 'Speed', '%')]],
    ],
    Shooter: [
      ['Shooter Spin Up', [pct('RPM', 'Target speed', 'rpm')], [outB('At Speed', 'At speed')]], ['Shooter Spin Up Speaker'], ['Shooter Spin Up Amp'],
      ['Shooter Spin Up Pass'], ['Shooter Set RPM', [pct('RPM', 'Speed', 'rpm')]], ['Shooter Stop'], ['Shooter Idle'],
      ['Shooter Wait For Speed', [T], [outB('At Speed', 'At speed')]], ['Shooter Shoot'], ['Shooter Shoot When Ready', [T], [outB('Shot', 'Shot fired')]],
      ['Shooter Shoot From Subwoofer'], ['Shooter Shoot From Podium'], ['Shooter Shoot From Wing'], ['Shooter Shoot From Stage'],
      ['Shooter Auto Aim Shot', [T], [outB('Shot', 'Shot fired'), outN('Distance', 'Distance to target', 'm')]], ['Shooter Trap Shot'],
      ['Shooter Pass To Wing'], ['Shooter Feed'], ['Shooter Hood To Angle', [pct('Angle', 'Hood angle', 'deg')]], ['Shooter Hood Home'],
      ['Shooter Hood Auto'], ['Shooter Hood Zero'], ['Shooter Spin Up (old)'], ['Shooter Shoot v2'], ['Shooter Set Spin Ratio', [pct('Ratio', 'Top/bottom ratio')]],
      ['Shooter Eject'], ['Shooter Hold Speed'],
    ],
    Arm: [
      ['Arm To Angle', [pct('Angle', 'Angle', 'deg'), T], [outB('At Target', 'At target')]], ['Arm Stow'], ['Arm Amp'], ['Arm Intake'], ['Arm Podium'],
      ['Arm Subwoofer'], ['Arm Trap'], ['Arm Home'], ['Arm Hold'], ['Arm Zero'], ['Arm Brake', [bool('On', 'Brake on')]],
      ['Arm Wait At Target', [T], [outB('At Target', 'At target')]], ['Arm Climb Position'], ['Arm Pass Position'], ['Arm Auto Aim', [T]],
      ['Arm Manual Up'], ['Arm Manual Down'], ['Arm To Angle (old)', [pct('Angle', 'Angle', 'deg')]],
    ],
    Elevator: [
      ['Elevator To Height', [pct('Height', 'Height', 'in'), T], [outB('At Height', 'At height')]], ['Elevator Low'], ['Elevator Mid'], ['Elevator High'],
      ['Elevator Home'], ['Elevator Stow'], ['Elevator Hold'], ['Elevator Zero'], ['Elevator Wait At Height', [T], [outB('At Height', 'At height')]],
      ['Elevator Trap Height'], ['Elevator Amp Height'], ['Elevator Climb Height'],
    ],
    Climber: [
      ['Climber Extend'], ['Climber Retract'], ['Climber Hold'], ['Climber Zero'], ['Climber Level', [T], [outN('Roll', 'Roll', 'deg')]],
      ['Climber Left Only', [pct('Speed', 'Speed', '%')]], ['Climber Right Only', [pct('Speed', 'Speed', '%')]], ['Climber Unlock'], ['Climber Lock'],
      ['Climber To Height', [pct('Height', 'Height', 'in')]],
    ],
    Vision: [
      ['Vision Set Pipeline', [en('Pipeline', 'Pipeline', ['AprilTags', 'Notes', 'Driver'])]], ['Vision LEDs On'], ['Vision LEDs Off'],
      ['Vision Wait For Target', [T], [outB('Visible', 'Target visible'), outN('Distance', 'Distance', 'm')]], ['Vision Snapshot'],
      ['Vision Reset Pose From Tags', [], [outB('Updated', 'Pose updated')]], ['Vision Track Note', [T], [outB('Visible', 'Note visible')]],
      ['Vision Enable Pose Updates'], ['Vision Disable Pose Updates'], ['Vision Set Priority Tag', [pct('Tag', 'Tag ID')]],
    ],
    LEDs: [
      ['LEDs Solid', [en('Color', 'Color', ['Red', 'Blue', 'Green', 'Orange', 'White'])]], ['LEDs Blink', [en('Color', 'Color', ['Red', 'Blue', 'Green', 'Orange', 'White'])]],
      ['LEDs Rainbow'], ['LEDs Alliance Color'], ['LEDs Off'], ['LEDs Has Note'], ['LEDs Ready To Shoot'], ['LEDs Auto Running'],
    ],
    Superstructure: [
      ['Score Speaker', [T], [outB('Scored', 'Scored')]], ['Score Amp', [T], [outB('Scored', 'Scored')]], ['Score Trap', [T]], ['Pickup Ground', [T], [outB('Has Note', 'Has note')]],
      ['Pickup Source', [T], [outB('Has Note', 'Has note')]], ['Handoff'], ['Prep Speaker Shot'], ['Prep Amp'], ['Prep Pass'], ['Shoot Preload'],
      ['Collect And Shoot', [T], [outB('Scored', 'Scored')]], ['Stow All'], ['Reset All Mechanisms'], ['Home All'], ['Climb Sequence', [T]],
      ['Eject All'], ['Prep Trap'], ['Score Speaker (old)', [T]],
    ],
    Utilities: [
      ['Wait For Match Time', [pct('Time', 'Match time', 's')]], ['Log Marker', [en('Marker', 'Marker', ['Start', 'Checkpoint', 'Done'])]],
      ['Print Message'], ['Set Alliance Flip', [bool('Flip', 'Flip')]], ['Reset Odometry'], ['Rumble Driver'], ['Brownout Guard'], ['Record Auto Start'],
    ],
    Test: [
      ['Test Intake Motor'], ['Test Shooter Motor'], ['Test Arm Motor'], ['Test Elevator Motor'], ['Test Climber Motor'], ['Test Drive Modules'],
      ['Test Indexer Motor'], ['Test LEDs'], ['Test Vision'], ['Test All Mechanisms'], ['Test Pneumatics'], ['Test Beam Breaks'],
    ],
    SysId: [
      ['SysId Drive Quasistatic Forward'], ['SysId Drive Quasistatic Reverse'], ['SysId Drive Dynamic Forward'], ['SysId Drive Dynamic Reverse'],
      ['SysId Shooter Quasistatic'], ['SysId Shooter Dynamic'], ['SysId Arm Quasistatic'], ['SysId Arm Dynamic'], ['SysId Elevator Quasistatic'], ['SysId Elevator Dynamic'],
    ],
  };
  const commands = [];
  for (const [folder, rows] of Object.entries(spec)) {
    const base = folder === 'Superstructure' || folder === 'Utilities' ? 'Commands/' + folder : folder === 'Test' || folder === 'SysId' ? 'Diagnostics/' + folder : 'Subsystems/' + folder + '/Commands';
    for (const [label, params = [], outputs = []] of rows) {
      const file = base + '/' + label + '.vi';
      const id = 'vi.' + (folder + '.' + label).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      commands.push({ id, label, member: file, ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', runtimeReady: false, labviewLegacy: true,
        source: { file, line: 1 }, parameters: params, outputs: [...outputs, status], labviewConnector: {} });
    }
  }
  const catalog = { runtime: 'labview', authoritative: true, generatedSchemaVersion: '1.3', projectName: 'Team 1234 Crescendo', sourceFileCount: commands.length,
    scannedAt: '', warnings: [], commands, conditions: [], builtIns: [{ id: 'bordeaux.wait', kind: 'wait' }] };
  return catalog;
})();
