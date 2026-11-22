# Task Board

## Purpose

The operations task board helps operators track work and find tasks by identifier, title, or owner.

## Requirements

### Requirement: List the current tasks
The service SHALL expose tasks through `GET /api/tasks`. The response SHALL include an `items` array and a `total` count. Task records SHALL include an identifier, title, owner, status, and last update time.

#### Scenario: Load the board
- **WHEN** the operator opens the task board
- **THEN** the page fetches the current tasks and displays them in descending order of update time, with ties ordered by task identifier ascending

### Requirement: Search tasks by keyword
The task list SHALL support an optional `q` parameter that matches substrings of the task identifier, title, or owner without regard to letter case.

#### Scenario: Submit a search
- **WHEN** the operator submits a keyword
- **THEN** the task board requests the matching tasks and preserves their default ordering

#### Scenario: Search has no matches
- **WHEN** no tasks match the keyword
- **THEN** the service returns an empty list with a total of zero and the page displays an empty state
