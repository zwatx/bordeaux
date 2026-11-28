"""Use the exact already-open project for Mac helper VIs. Developer-only VI authoring code."""


def find_open_project(builder, project_path, member):
    """Return a project reference (invalid if closed) and the project-list error wire."""
    projects = member(builder, 'property', 'Application', 'Project.Projects[]')
    count = builder.node('Array Size', array=projects['Project'])
    loop = builder.for_loop(count['size(s)'], location=(300, 850), size=(600, 280))
    item = loop.body.node('Index Array', array=loop.outer(projects['Project']), index=loop.i)
    file = member(loop.body, 'property', 'Project', 'Path', item['element'])
    requested = builder.node('String To Path', string=project_path)
    match = builder.node('Search 1D Array', element=requested['path'])
    builder.wire(loop.indexed(file['Path']), match['1D array'])
    selected = builder.node('Index Array', array=projects['Project'], index=match['index of element'])
    return selected['element'], projects['error out']
