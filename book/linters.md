# Linters in TermTree

Given a tree of AST nodes without whitespace, how do you generate the
whitespace? Given a tree of CST nodes with whitespace, how do you edit
the CST? Editing means you lose all the position offsets on the
subsequent nodes.

So given the syntax nodes, you lint, to check without modifying the
tree.

Then we have AST code generation, without any whitespace. This is
transformed into a CST with no offset tracking. This CST is then linted
and fixed to format it nicely.

Conversion from the generated AST to CST is basically a linting rule.

    task.name.tree.fold.text.last

    task.keyword

How to access the `task ` text to add or remove whitespace after it?

    task.hook.type === 'term'

It needs to know about the interpolation too. So really we are creating
a link tree. But then how do you get fast access to the higher level
constructs?

It needs to know if the link text represents a `task` for example.

    if node.type === task
      make sure 1 blank line before

    Something <{cool}>

    if (!node.text) {

    }

    insertTextBefore(node.text.tree.fold.text, '\n')

makeTaskText => a function which creates the AST node with the
link/fold/text nodes makeTask => a function which creates the AST node
from existing link nodes (i.e. the reverse of makeTaskText, or rather,
just one half of makeTaskText)

    makeTaskText

How will the parser show a task if there is interpolation before it is
ready, and generated tree when it is ready? You don't want to edit the
generated tree, just the written tree.

You could handle that by saying only the ones with `.text.tree` on them
you pass to the rule handlers. But what about having interpolation
inside a task? You don't know what the interpolation is for yet, so how
can you build the task?

It would have to be a tree, but perhaps you could label the tree nodes
with the potential type.

    {
      type: 'task',
      children: [
        whitespace
        link // for {name}
        link
        take
        whitespace
        link
        take
        call
        link
        call
      ]
    }

Then that can have the whitespace in it still.

So then it goes from that, the "tree" type, to the "mesh" type which is
the compact, typed, resolved AST.

    {
      type: 'task',
      call: [],
      take: [],
    }

The linter gets the tree type, and works on that. The type checker gets
the mesh type, and works on that. The mesh links back to the tree.

    mesh.tree
    tree.tree
    link.fold
    fold.text

    tree.treegoes to link text
    tree.nest goes to the children

So then when we construct the mesh type and generate code from it, it is
a custom task. It creates the tree base form. From the tree form, we can
automatically run it through a fixer to fix the layout.

Then we have the `rise` form, which is the builder form.

    rise
    mesh
    tree
    link
    fold
    text

Rise handles things like collecting the imports and exports. The rise is
what you construct when coming from scratch or from another language.

You go from rise -> mesh -> tree then pass that through the linter, then
tree -> link -> fold -> text.

The rise gives you the names of the imports encountered, as well as the
exports and the types, so you can use that in other rises.

    make({ importable: previousRise.exports })

    text == tokens
    fold == untyped tree
    link == typed tree 1 (tokens)
    tree == typed tree 2 (untyped tree)
    mesh == typed tree 3 (typed tree)

The fold is simply an event stream

    crow/lint/code (ast modifications)
    crow/lint/text (pretty print)

The linter rewrites the AST

https://github.com/estools/esquery

https://github.com/eslint/eslint/discussions/16557
